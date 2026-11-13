package ws_test

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws"
)

// fakeRingPusher records each bookkeeping call and each push sent, and answers every call with a push to
// send so the hub's background send path runs.
type fakeRingPusher struct {
	mu    syncutil.Mutex
	calls []string
	sent  chan service.RingPush
}

func newFakeRingPusher() *fakeRingPusher {
	return &fakeRingPusher{sent: make(chan service.RingPush, 16)}
}

func (f *fakeRingPusher) record(call string, p service.RingPush) service.RingPush {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
	return p
}

func (f *fakeRingPusher) RingStarted(channelID, callerID int64, targets []int64) service.RingPush {
	ids := slices.Clone(targets)
	slices.Sort(ids)
	return f.record(fmt.Sprintf("ring %d from %d to %v", channelID, callerID, ids),
		service.RingPush{ChannelID: channelID, CallerID: callerID, UserIDs: targets})
}

func (f *fakeRingPusher) RingAnswered(channelID, userID int64) service.RingPush {
	return f.record(fmt.Sprintf("answered %d by %d", channelID, userID),
		service.RingPush{End: true, ChannelID: channelID, UserIDs: []int64{userID}})
}

func (f *fakeRingPusher) RingLeft(channelID, userID int64) service.RingPush {
	return f.record(fmt.Sprintf("left %d by %d", channelID, userID),
		service.RingPush{End: true, ChannelID: channelID, UserIDs: []int64{userID}})
}

func (f *fakeRingPusher) SendRing(_ context.Context, p service.RingPush) { f.sent <- p }

func (f *fakeRingPusher) requireCalls(t *testing.T, want ...string) {
	t.Helper()
	f.mu.Lock()
	got := slices.Clone(f.calls)
	f.mu.Unlock()
	if !slices.Equal(got, want) {
		t.Errorf("ring push calls = %q, want %q", got, want)
	}
}

func (f *fakeRingPusher) requireSent(t *testing.T, end bool, channelID int64) {
	t.Helper()
	select {
	case p := <-f.sent:
		if p.End != end || p.ChannelID != channelID {
			t.Errorf("sent %+v, want end=%v channel=%d", p, end, channelID)
		}
	case <-time.After(waitTimeout):
		t.Fatal("no ring push was sent")
	}
}

func TestRingPush_RingAndDeclineReachThePusher(t *testing.T) {
	hub, _, alice, bob, carol, chID := newGroupDMTrio(t, "ringpush", "Pushers")
	pusher := newFakeRingPusher()
	hub.SetRingPusher(pusher)
	cAlice, _ := connectRingPair(t, hub, alice, bob, chID)
	cBob := ws.NewTestClientWithUser(hub, bob, chID, make(chan []byte, 64))
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)

	hub.HandleMessageForTest(cAlice, callMsg("call_ring", chID))
	pusher.requireSent(t, false, chID)
	hub.HandleMessageForTest(cBob, callMsg("call_decline", chID))
	pusher.requireSent(t, true, chID)

	ids := []int64{bob.ID, carol.ID}
	slices.Sort(ids)
	pusher.requireCalls(t,
		fmt.Sprintf("ring %d from %d to %v", chID, alice.ID, ids),
		fmt.Sprintf("answered %d by %d", chID, bob.ID))
}

func TestRingPush_RefusedRingRecordsNothing(t *testing.T) {
	hub, _, alice, bob, _, chID := newGroupDMTrio(t, "ringpush-out", "Outside")
	pusher := newFakeRingPusher()
	hub.SetRingPusher(pusher)
	cAlice, _ := connectRingPair(t, hub, alice, bob, chID)
	ws.SetVoiceChIDForTest(cAlice, 0)

	hub.HandleMessageForTest(cAlice, callMsg("call_ring", chID))
	pusher.requireCalls(t)
}

func TestRingPush_JoinAnswersAndLeaveEnds(t *testing.T) {
	hub, database := newCoverageHub(t)
	pusher := newFakeRingPusher()
	hub.SetRingPusher(pusher)
	user := seedCoverageOwner(t, database, "ringpush-joiner")
	vcID := seedVoiceChannel(t, database, "ringpush-vc")
	c, _ := connectClient(t, hub, user, 0, 64)

	hub.HandleMessageForTest(c, envelope("voice_join", map[string]any{"channel_id": vcID}))
	pusher.requireSent(t, true, vcID)
	hub.HandleVoiceLeaveForTest(c)
	pusher.requireSent(t, true, vcID)

	pusher.requireCalls(t,
		fmt.Sprintf("answered %d by %d", vcID, user.ID),
		fmt.Sprintf("left %d by %d", vcID, user.ID))
}

func TestRingPush_OffByDefaultAndAfterUnset(t *testing.T) {
	hub, _, alice, bob, _, chID := newGroupDMTrio(t, "ringpush-off", "Off")
	pusher := newFakeRingPusher()
	hub.SetRingPusher(pusher)
	hub.SetRingPusher(nil)
	cAlice, _ := connectRingPair(t, hub, alice, bob, chID)

	hub.HandleMessageForTest(cAlice, callMsg("call_ring", chID))
	pusher.requireCalls(t)
}
