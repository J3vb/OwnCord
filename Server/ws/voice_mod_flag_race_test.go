package ws

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// startRacingMute runs a moderator mute (or unmute) on another goroutine and
// returns once it has finished or is queued behind the moderation lock the
// caller's path holds. The channel yields what the moderator was told. The
// mute outlives the caller's own request, so it keeps ctx's values only.
func startRacingMute(ctx context.Context, t *testing.T, h *Hub, userID, channelID int64, muted bool) <-chan bool {
	told := make(chan bool, 1)
	finished := make(chan struct{})
	muteCtx := context.WithoutCancel(ctx)
	go func() {
		matched, _, _ := h.SetServerMuteLocked(muteCtx, userID, channelID, muted)
		told <- matched
		close(finished)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for h.voiceHub.mod.Refs(userID) < 2 {
		select {
		case <-finished:
			return told
		case <-time.After(time.Millisecond):
		}
		if time.Now().After(deadline) {
			t.Error("the racing mute neither finished nor queued")
			return told
		}
	}
	return told
}

// muteDuringLeaveVoice runs a moderator mute while the row is being deleted:
// the first LeaveIfMatch starts the mute and goes on once it has committed or
// is waiting for the leave. matched is what the moderator was told.
type muteDuringLeaveVoice struct {
	VoiceStore
	t       *testing.T
	h       *Hub
	userID  int64
	started atomic.Bool
	matched chan bool
}

func (s *muteDuringLeaveVoice) LeaveIfMatch(ctx context.Context, userID, channelID int64, joinedAt string) (bool, error) {
	if userID == s.userID && s.started.CompareAndSwap(false, true) {
		told := startRacingMute(ctx, s.t, s.h, userID, channelID, true)
		go func() { s.matched <- <-told }()
	}
	return s.VoiceStore.LeaveIfMatch(ctx, userID, channelID, joinedAt)
}

// wrapMuteDuringLeave installs the store on f's hub.
func wrapMuteDuringLeave(f *mdFix) *muteDuringLeaveVoice {
	s := &muteDuringLeaveVoice{VoiceStore: f.hub.voice, t: f.t, h: f.hub, userID: f.uid, matched: make(chan bool, 1)}
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

// And when a moderator moves the member: the eviction holds the same lock.
func TestModeratorMove_MuteRacingTheEvictionIsNotLost(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	f.join(a, f.voiceA)
	s := wrapMuteDuringLeave(f)

	if !evictForMove(context.Background(), f.hub, f.uid, f.voiceA, false, false, nil) {
		t.Fatal("the move did not evict")
	}
	f.join(a, f.voiceB)

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

// A moderator unmute that lands while a muted member's join is putting the mute
// back on the new row is not overwritten by it: an unmute reported as applied
// leaves the member unmuted.
func TestVoiceJoin_UnmuteRacingTheFlagRestoreIsNotOverwritten(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	f.join(a, f.voiceA)
	ctx := context.Background()
	if matched, _, err := f.hub.SetServerMuteLocked(ctx, f.uid, f.voiceA, true); err != nil || !matched {
		t.Fatalf("SetServerMuteLocked = %v, %v", matched, err)
	}

	told := make(chan (<-chan bool), 1)
	var once sync.Once
	voiceJoinPostCommitRaceHook = func(c *Client) {
		if c != a.c {
			return
		}
		// The new row exists and does not carry the mute yet.
		once.Do(func() { told <- startRacingMute(ctx, t, f.hub, f.uid, f.voiceB, false) })
	}
	t.Cleanup(func() { voiceJoinPostCommitRaceHook = nil })

	f.hub.handleMessage(a.c, voiceFrame(t, "voice_join", "join", map[string]any{"channel_id": f.voiceB}))
	a.settle()

	var unmuted bool
	select {
	case res := <-told:
		select {
		case unmuted = <-res:
		case <-time.After(5 * time.Second):
			t.Fatal("the unmute never returned")
		}
	default:
		t.Fatal("the join never reached the new row: the test does not exercise the race")
	}
	row := f.row(f.uid)
	if row == nil || row.ChannelID != f.voiceB {
		t.Fatalf("row after the switch = %+v, want one in channel %d", row, f.voiceB)
	}
	if unmuted == row.ServerMuted {
		t.Fatalf("the moderator was told unmuted=%v and the row has server_muted=%v", unmuted, row.ServerMuted)
	}
}

// failFlagReadVoice fails the first State read made while the member's
// moderation lock is held, which is the read of the flags a leave carries.
type failFlagReadVoice struct {
	VoiceStore
	h      *Hub
	userID int64
	failed atomic.Bool
}

func (s *failFlagReadVoice) State(ctx context.Context, userID int64) (*db.VoiceState, error) {
	if userID == s.userID && s.h.voiceHub.mod.Refs(userID) > 0 && s.failed.CompareAndSwap(false, true) {
		return nil, errors.New("test: voice state read failed")
	}
	return s.VoiceStore.State(ctx, userID)
}

// When the flags a leave must carry cannot be read, the leave does not happen:
// the member stays where they are, still muted, and the next attempt carries
// the mute.
func TestVoiceLeaveForMove_UnreadableFlagsRefuseTheMove(t *testing.T) {
	for _, tc := range []struct {
		name string
		// move tries to take the member from voiceA to voiceB and reports
		// whether the first attempt was refused.
		move func(t *testing.T, f *mdFix, a, b *mdDev) (refused bool, retry func())
	}{
		{
			name: "moderator move",
			move: func(t *testing.T, f *mdFix, a, _ *mdDev) (bool, func()) {
				refused := !evictForMove(context.Background(), f.hub, f.uid, f.voiceA, true, false, nil)
				return refused, func() {
					if !evictForMove(context.Background(), f.hub, f.uid, f.voiceA, true, false, nil) {
						t.Fatal("the retried move did not evict")
					}
					f.join(a, f.voiceB)
				}
			},
		},
		{
			name: "channel switch",
			move: func(t *testing.T, f *mdFix, a, _ *mdDev) (bool, func()) {
				f.hub.handleMessage(a.c, voiceFrame(t, "voice_join", "join", map[string]any{"channel_id": f.voiceB}))
				a.settle()
				return a.c.voice.channel() == f.voiceA, func() { f.join(a, f.voiceB) }
			},
		},
		{
			name: "call moved to another device",
			move: func(t *testing.T, f *mdFix, a, b *mdDev) (bool, func()) {
				f.hub.handleMessage(b.c, voiceFrame(t, "voice_join", "join", map[string]any{"channel_id": f.voiceB}))
				b.settle()
				return a.c.voice.channel() == f.voiceA && b.c.voice.channel() == 0, func() { f.join(b, f.voiceB) }
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMDFix(t)
			a := f.dev("session-a", f.text)
			b := f.dev("session-b", f.text)
			f.join(a, f.voiceA)
			if matched, _, err := f.hub.SetServerMuteLocked(context.Background(), f.uid, f.voiceA, true); err != nil || !matched {
				t.Fatalf("SetServerMuteLocked = %v, %v", matched, err)
			}
			s := &failFlagReadVoice{VoiceStore: f.hub.voice, h: f.hub, userID: f.uid}
			f.hub.voice = s

			refused, retry := tc.move(t, f, a, b)
			if !s.failed.Load() {
				t.Fatal("no flag read failed: the test does not exercise the refusal")
			}
			if !refused {
				t.Fatal("the move went ahead without knowing the flags")
			}
			if row := f.row(f.uid); row == nil || row.ChannelID != f.voiceA || !row.ServerMuted {
				t.Fatalf("row after the refused move = %+v, want the muted one in channel %d", row, f.voiceA)
			}

			retry()
			if row := f.row(f.uid); row == nil || row.ChannelID != f.voiceB || !row.ServerMuted {
				t.Fatalf("row after the retry = %+v, want a muted one in channel %d", row, f.voiceB)
			}
		})
	}
}

// A mute owned by a timeout keeps its owner in the stash a moderator move
// leaves, so the timeout's end can still lift it after the re-join.
func TestModeratorMove_StashKeepsTheMuteOwner(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	token := f.join(a, f.voiceA)
	action := seedTimeoutActionForTest(t, f.db, f.uid)
	ctx := context.Background()
	if applied, owned := f.hub.MuteForTimeout(ctx, f.uid, f.voiceA, action, token, nil); !applied || !owned {
		t.Fatalf("MuteForTimeout applied=%v owned=%v", applied, owned)
	}

	// The mover's check saw no mute: the owner comes from the row.
	if !evictForMove(ctx, f.hub, f.uid, f.voiceA, false, false, nil) {
		t.Fatal("the move did not evict")
	}
	muted, _, mutedBy := a.c.voice.takeModFlags()
	if !muted || mutedBy == nil || *mutedBy != action {
		t.Fatalf("stash = (muted %v, owner %v), want the mute owned by timeout %d", muted, mutedBy, action)
	}
}
