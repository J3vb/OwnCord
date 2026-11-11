package ws

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// muteDuringLeaveVoice runs a moderator mute while the row is being deleted: the
// first LeaveIfMatch starts the mute and gives it time to commit before the
// delete goes on. matched is what the moderator was told.
type muteDuringLeaveVoice struct {
	VoiceStore
	h       *Hub
	userID  int64
	started atomic.Bool
	matched chan bool
}

func (s *muteDuringLeaveVoice) LeaveIfMatch(ctx context.Context, userID, channelID int64, joinedAt string) (bool, error) {
	if userID == s.userID && s.started.CompareAndSwap(false, true) {
		done := make(chan bool, 1)
		go func() {
			matched, _, _ := s.h.SetServerMuteLocked(context.WithoutCancel(ctx), userID, channelID, true)
			done <- matched
		}()
		select {
		case m := <-done:
			s.matched <- m
		case <-time.After(150 * time.Millisecond):
			// The mute is waiting for the leave: it reports after the delete.
			go func() { s.matched <- <-done }()
		}
	}
	return s.VoiceStore.LeaveIfMatch(ctx, userID, channelID, joinedAt)
}

// wrapMuteDuringLeave installs the store on f's hub.
func wrapMuteDuringLeave(f *mdFix) *muteDuringLeaveVoice {
	s := &muteDuringLeaveVoice{VoiceStore: f.hub.voice, h: f.hub, userID: f.uid, matched: make(chan bool, 1)}
	f.hub.voice = s
	return s
}

// expectMuteNotLost fails when the moderator was told the mute applied and the
// member's row in ch does not carry it.
func expectMuteNotLost(t *testing.T, f *mdFix, s *muteDuringLeaveVoice, ch int64) {
	t.Helper()
	if !s.started.Load() {
		t.Fatal("the leave never ran: the test does not exercise the race")
	}
	var matched bool
	select {
	case matched = <-s.matched:
	case <-time.After(5 * time.Second):
		t.Fatal("the mute never returned")
	}
	row := f.row(f.uid)
	if row == nil || row.ChannelID != ch {
		t.Fatalf("row after the join = %+v, want one in channel %d", row, ch)
	}
	if matched && !row.ServerMuted {
		t.Fatal("the moderator was told the mute applied, and the member arrived unmuted")
	}
}

// A moderator mute that lands while the member switches channel is either
// carried to the new channel or refused: it is never reported applied and lost.
func TestVoiceJoin_MuteRacingAChannelSwitchIsNotLost(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	f.join(a, f.voiceA)
	s := wrapMuteDuringLeave(f)

	f.hub.handleMessage(a.c, voiceFrame(t, "voice_join", "join", map[string]any{"channel_id": f.voiceB}))
	a.settle()

	expectMuteNotLost(t, f, s, f.voiceB)
}

// The same holds when the call moves to another of the member's devices.
func TestMultiDevice_MuteRacingACallMoveIsNotLost(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	b := f.dev("session-b", f.text)
	f.join(a, f.voiceA)
	s := wrapMuteDuringLeave(f)

	f.hub.handleMessage(b.c, voiceFrame(t, "voice_join", "join", map[string]any{"channel_id": f.voiceB}))
	b.settle()

	expectMuteNotLost(t, f, s, f.voiceB)
}

// A moderator move carries the flags the row holds when it is evicted, not the
// ones the mover's earlier check read: a mute that landed in between follows
// the member, and one that was lifted in between does not come back.
func TestModeratorMove_CarriesTheFlagsTheRowHoldsAtEviction(t *testing.T) {
	for _, tc := range []struct {
		name               string
		checkedMuted, want bool
	}{
		{name: "muted after the check", checkedMuted: false, want: true},
		{name: "unmuted after the check", checkedMuted: true, want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMDFix(t)
			a := f.dev("session-a", f.text)
			f.join(a, f.voiceA)
			ctx := context.Background()
			// The other moderator's change, committed after the mover's check.
			if tc.want {
				if matched, _, err := f.hub.SetServerMuteLocked(ctx, f.uid, f.voiceA, true); err != nil || !matched {
					t.Fatalf("SetServerMuteLocked = %v, %v", matched, err)
				}
			}

			if !evictForMove(ctx, f.hub, f.uid, f.voiceA, tc.checkedMuted, false, nil) {
				t.Fatal("the move did not evict")
			}
			f.join(a, f.voiceB)

			row := f.row(f.uid)
			if row == nil || row.ChannelID != f.voiceB {
				t.Fatalf("row after the re-join = %+v, want one in channel %d", row, f.voiceB)
			}
			if row.ServerMuted != tc.want {
				t.Fatalf("server_muted after the move = %v, want %v", row.ServerMuted, tc.want)
			}
		})
	}
}
