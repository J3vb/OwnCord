package ws

import (
	"bytes"
	"context"
	"testing"
)

// A recipients frame names the users connected when its audience was resolved.
// A connection that resumes between that moment and the frame's delivery is
// past its replay (the frame's seq is newer) and absent from the list, so
// delivery has to reach it by the rule its replay used.

type lateResumeFixture struct {
	*audienceFixture
	lastSeq uint64
}

func newLateResumeFixture(t *testing.T) *lateResumeFixture {
	t.Helper()
	f := &lateResumeFixture{audienceFixture: newAudienceFixture(t, 1)}
	// Two earlier frames, so the ring covers the resume point.
	f.hub.deliverBroadcast(broadcastMsg{msg: []byte(`{"type":"roles_update","payload":{}}`)})
	f.hub.deliverBroadcast(broadcastMsg{msg: []byte(`{"type":"roles_update","payload":{}}`)})
	f.lastSeq = f.hub.CurrentSeq()
	return f
}

// resume registers uid through the replaying resume path and returns its
// connection and the replayed events.
func (f *lateResumeFixture) resume(t *testing.T, uid int64) (*Client, [][]byte) {
	t.Helper()
	ctx := context.Background()
	u, err := f.database.GetUserByID(ctx, uid)
	if err != nil || u == nil {
		t.Fatalf("GetUserByID %d: %v", uid, err)
	}
	allowed, err := f.hub.computeAllowedChannels(ctx, f.hub.readers.Visibility, u)
	if err != nil {
		t.Fatalf("computeAllowedChannels: %v", err)
	}
	c := NewTestClientWithUser(f.hub, u, 0, make(chan []byte, 16))
	c.lastSeq = f.lastSeq
	events, ok := f.hub.reconnectRegister(ctx, c, f.lastSeq, allowed, allowed, "buffer", nil, 0)
	if !ok {
		t.Fatal("reconnectRegister refused the replay")
	}
	return c, events
}

func liveCopies(c *Client, marker string) int {
	n := 0
	for len(c.send) > 0 {
		if bytes.Contains(<-c.send, []byte(marker)) {
			n++
		}
	}
	return n
}

func renameFrame() []byte {
	return []byte(`{"type":"channel_update","payload":{"id":1,"name":"renamed"}}`)
}

func TestRecipientsFrame_ReachesAResumeRegisteredAfterItsAudience(t *testing.T) {
	f := newLateResumeFixture(t)
	ctx := context.Background()
	h := f.hub
	resumer := f.createUser(t, "resumer", 4)

	// The producer resolves the audience; the resumer's old socket is gone.
	mark := h.audienceMark()
	audience := h.channelReadAudience(ctx, f.chID)

	c, replayed := f.resume(t, resumer)

	h.deliverBroadcast(broadcastMsg{channelID: f.chID, msg: renameFrame(), recipients: audience, audienceMark: mark})

	for _, e := range replayed {
		if bytes.Contains(e, []byte(`"renamed"`)) {
			t.Fatal("setup: the frame must be sequenced after the resume's replay")
		}
	}
	if got := liveCopies(c, `"renamed"`); got != 1 {
		t.Fatalf("late resume received %d copies of the frame, want 1", got)
	}
	// A frame resolved after the registration finds the user in its audience
	// and takes the ordinary path: still one copy.
	mark = h.audienceMark()
	audience = h.channelReadAudience(ctx, f.chID)
	h.deliverBroadcast(broadcastMsg{channelID: f.chID, msg: renameFrame(), recipients: audience, audienceMark: mark})
	if got := liveCopies(c, `"renamed"`); got != 1 {
		t.Fatalf("second frame reached the connection %d times, want 1", got)
	}
}

func TestRecipientsFrame_SyncSendReachesALateResume(t *testing.T) {
	f := newLateResumeFixture(t)
	ctx := context.Background()
	h := f.hub
	resumer := f.createUser(t, "resumer", 4)

	mark := h.audienceMark()
	audience := h.channelReadAudience(ctx, f.chID)
	c, _ := f.resume(t, resumer)

	h.sendSequencedToUsers(f.chID, audience, mark, renameFrame())

	if got := liveCopies(c, `"renamed"`); got != 1 {
		t.Fatalf("late resume received %d copies of the frame, want 1", got)
	}
}

func TestRecipientsFrame_LateResumeOutsideTheChannelGetsNothing(t *testing.T) {
	f := newLateResumeFixture(t)
	ctx := context.Background()
	h := f.hub
	resumer := f.createUser(t, "resumer", 4)
	hidden := f.chID + 1000 // not in the set the resume's replay was filtered by

	mark := h.audienceMark()
	audience := h.channelReadAudience(ctx, f.chID)
	c, _ := f.resume(t, resumer)

	h.deliverBroadcast(broadcastMsg{channelID: hidden, msg: renameFrame(), recipients: audience, audienceMark: mark})

	if got := liveCopies(c, `"renamed"`); got != 0 {
		t.Fatalf("a frame of a channel outside the resume's set reached it %d times", got)
	}
}

func TestRecipientsFrame_OtherLateConnectionsAreNotSentTwice(t *testing.T) {
	f := newLateResumeFixture(t)
	ctx := context.Background()
	h := f.hub
	listed := f.users[0]

	mark := h.audienceMark()
	audience := h.channelReadAudience(ctx, f.chID)

	// A fresh connect after the audience: its ready is read after it registered.
	fresh := f.createUser(t, "fresh", 4)
	f.connect(t, fresh)
	// A second device of a listed user resumes late: SendToUser reaches it.
	second, _ := f.resume(t, listed)

	h.deliverBroadcast(broadcastMsg{channelID: f.chID, msg: renameFrame(), recipients: audience, audienceMark: mark})

	if got := liveCopies(f.conns[fresh], `"renamed"`); got != 0 {
		t.Fatalf("fresh connect received %d copies, want 0", got)
	}
	if got := liveCopies(second, `"renamed"`); got != 1 {
		t.Fatalf("listed user's late device received %d copies, want 1", got)
	}
}

func TestRecipientsLoss_MarksALateResume(t *testing.T) {
	f := newLateResumeFixture(t)
	ctx := context.Background()
	h := f.hub
	resumer := f.createUser(t, "resumer", 4)

	mark := h.audienceMark()
	audience := h.channelReadAudience(ctx, f.chID)
	c, _ := f.resume(t, resumer)

	h.seqMu.Lock()
	h.markLoss(lossRoute{channelID: f.chID, recipients: audience, audienceMark: mark})
	h.seqMu.Unlock()

	if !c.cseq.lossPending.Load() || !h.presenceResyncPending(c.userID, c.tokenHash) {
		t.Fatal("a late resume that missed a lost recipients frame owes a resync")
	}
}

// A call's members get its voice frames whether or not they may read the
// channel, and a resume inherits its call. That reach is for voice frames
// only: a rename of the same channel stays with the channel's readers.
func TestRecipientsFrame_InheritedCallOutsideTheSetGetsOnlyVoiceFrames(t *testing.T) {
	f := newLateResumeFixture(t)
	ctx := context.Background()
	h := f.hub
	resumer := f.createUser(t, "resumer", 4)
	call := f.chID + 1000 // not in the set the resume's replay was filtered by

	mark := h.audienceMark()
	audience := h.channelReadAudience(ctx, f.chID)
	c, _ := f.resume(t, resumer)
	c.voice.setState(call, "tok")

	h.deliverBroadcast(broadcastMsg{channelID: call, msg: renameFrame(), recipients: audience, audienceMark: mark})
	if got := liveCopies(c, `"renamed"`); got != 0 {
		t.Fatalf("a rename of a channel the resume cannot read reached it %d times", got)
	}

	h.deliverBroadcast(broadcastMsg{channelID: call, msg: buildVoiceLeave(call, f.users[0]), recipients: audience, audienceMark: mark})
	if got := liveCopies(c, `"voice_leave"`); got != 1 {
		t.Fatalf("the inherited call's voice_leave reached the resume %d times, want 1", got)
	}
}

// Every producer of a recipients frame reads the mark for it: one that stopped
// would silently lose the late resume again.
func TestRecipientsFrame_ProducersCarryAMark(t *testing.T) {
	f := newLateResumeFixture(t)
	ctx := context.Background()
	h := f.hub
	leave := buildVoiceLeave(f.chID, f.users[0])

	producers := map[string]func(){
		"broadcastChannelScoped":        func() { h.broadcastChannelScoped(ctx, f.chID, renameFrame(), "channel_update") },
		"broadcastVoiceEvent":           func() { h.broadcastVoiceEvent(ctx, f.chID, f.users[0], leave) },
		"broadcastVoiceEventWithLeaver": func() { h.broadcastVoiceEventWithLeaver(ctx, f.chID, leave, f.users[0]) },
	}
	for name, produce := range producers {
		produce()
		select {
		case bm := <-h.broadcast:
			if bm.audienceMark == 0 {
				t.Errorf("%s enqueued a recipients frame with no mark", name)
			}
		default:
			t.Errorf("%s enqueued nothing", name)
		}
	}
}
