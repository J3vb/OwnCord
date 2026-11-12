package ws

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// stateFailsAfterSlotCleared fails the first State read made once the old
// device's call slot is cleared: the read a move uses to confirm the old row is
// gone (or is the one it kept).
type stateFailsAfterSlotCleared struct {
	VoiceStore
	old    *Client
	failed atomic.Bool
}

func (s *stateFailsAfterSlotCleared) State(ctx context.Context, userID int64) (*db.VoiceState, error) {
	if s.old.voice.channel() == 0 && s.failed.CompareAndSwap(false, true) {
		return nil, errors.New("state read failed")
	}
	return s.VoiceStore.State(ctx, userID)
}

// joinRacesMove runs another user's capacity-checked join just before the
// mover's own insert: the moment the slot would be free if the move had
// removed the row first.
type joinRacesMove struct {
	VoiceStore
	mover, racer, chID int64
	capacity           int
	raced              atomic.Bool
	racerErr           error
}

func (s *joinRacesMove) Join(ctx context.Context, userID, channelID int64, maxUsers int) error {
	if userID == s.mover && s.raced.CompareAndSwap(false, true) {
		s.racerErr = s.VoiceStore.Join(ctx, s.racer, s.chID, s.capacity)
	}
	return s.VoiceStore.Join(ctx, userID, channelID, maxUsers)
}

// voiceLeaves counts the voice_leave frames for (ch, uid) the device has seen.
func (d *mdDev) voiceLeaves(ch, uid int64) int {
	n := 0
	for i := 0; ; i++ {
		i = d.index(i, MsgTypeVoiceLeaveBC, func(p map[string]any) bool {
			return int64Of(p["channel_id"]) == ch && int64Of(p["user_id"]) == uid
		})
		if i < 0 {
			return n
		}
		n++
	}
}

// newSameChannelMove puts the account's call on device A in voiceA, with an
// observer in the room, and returns a second device B of the account that has
// no call yet.
func newSameChannelMove(t *testing.T) (f *mdFix, obs, a, b *mdDev) {
	t.Helper()
	f = newMDFix(t)
	obs = f.observer(f.voiceA)
	a = f.dev("session-a", f.text)
	b = f.dev("session-b", f.text)
	f.join(a, f.voiceA)
	f.join(obs, f.voiceA)
	return f, obs, a, b
}

// takeOverSameChannel has B join the channel A's call is in, which moves the
// call to B, and collects what each device was sent from then on.
func takeOverSameChannel(t *testing.T, f *mdFix, obs, a, b *mdDev) {
	t.Helper()
	obs.pump()
	obs.got = nil
	f.hub.handleMessage(b.c, voiceFrame(t, "voice_join", "join", map[string]any{"channel_id": f.voiceA}))
	b.settle()
	obs.settle()
	a.settle()
}

// A same-channel call move into a channel that is already over its cap must keep
// the slot the user held: the move succeeds and nobody sees the user leave.
func TestMultiDevice_SameChannelMoveIntoOverfullChannelKeepsSlot(t *testing.T) {
	f, obs, a, b := newSameChannelMove(t)
	if err := f.db.SetChannelVoiceMaxUsers(context.Background(), f.voiceA, 1); err != nil {
		t.Fatalf("SetChannelVoiceMaxUsers: %v", err)
	}

	takeOverSameChannel(t, f, obs, a, b)

	if b.sawErrorCode(ErrCodeChannelFull) {
		t.Fatalf("the move was refused as full although the user already held the slot; got %s", b.types())
	}
	if row := f.row(f.uid); row == nil || row.ChannelID != f.voiceA {
		t.Fatalf("row after the move = %+v, want one in channel %d", row, f.voiceA)
	}
	if got := b.c.voice.channel(); got != f.voiceA {
		t.Fatalf("B's voice channel = %d, want %d", got, f.voiceA)
	}
	if obs.sawVoiceLeave(f.voiceA, f.uid) {
		t.Fatal("a successful same-channel move announced a voice_leave")
	}
}

// A same-channel move that fails after the old membership was ended without an
// announcement (here: the token cannot be minted) must announce that leave, so
// no roster keeps showing the user in the channel.
func TestMultiDevice_SameChannelMoveFailingLaterStepAnnouncesLeave(t *testing.T) {
	f, obs, a, b := newSameChannelMove(t)
	// An empty signing secret makes the next token mint fail.
	f.hub.livekit.apiSecret = ""

	takeOverSameChannel(t, f, obs, a, b)

	if !b.sawErrorCode(ErrCodeInternal) {
		t.Fatalf("B got no INTERNAL error; got %s", b.types())
	}
	if row := f.row(f.uid); row != nil {
		t.Fatalf("a failed join left a row: %+v", row)
	}
	if !obs.sawVoiceLeave(f.voiceA, f.uid) {
		t.Fatalf("the roster was never told the user left; observer got %s", obs.types())
	}
	if !b.sawVoiceLeave(f.voiceA, f.uid) {
		t.Fatalf("the joining device was not told the user left; got %s", b.types())
	}
	if b.c.voice.channel() != 0 || a.c.voice.channel() != 0 {
		t.Fatal("a device still holds a call after the failed join")
	}
}

// A same-channel move whose check that the old row is gone cannot be read must
// announce the leave it held back: no device holds the call any more.
func TestMultiDevice_SameChannelMoveUnverifiedLeaveIsAnnounced(t *testing.T) {
	f, obs, a, b := newSameChannelMove(t)
	store := &stateFailsAfterSlotCleared{VoiceStore: f.hub.voice, old: a.c}
	f.hub.voice = store

	takeOverSameChannel(t, f, obs, a, b)

	if !store.failed.Load() {
		t.Fatal("the state read never failed: the test does not exercise the abort")
	}
	if !b.sawErrorCode(ErrCodeInternal) {
		t.Fatalf("B got no INTERNAL error; got %s", b.types())
	}
	if got := obs.voiceLeaves(f.voiceA, f.uid); got != 1 {
		t.Fatalf("observer saw %d voice_leave frames, want 1; got %s", got, obs.types())
	}
	if b.c.voice.channel() != 0 || a.c.voice.channel() != 0 {
		t.Fatal("a device still holds a call after the aborted move")
	}
	if row := f.row(f.uid); row != nil {
		t.Fatalf("the aborted move left the kept row: %+v", row)
	}
}

// A same-channel move rolled back by its last step (the roster read) announces
// the leave once: the rollback's own broadcast, with no second one on top.
func TestMultiDevice_SameChannelMoveRolledBackAtRosterReadAnnouncesOnce(t *testing.T) {
	f, obs, a, b := newSameChannelMove(t)
	store := &failOnceStatesVoice{VoiceStore: f.hub.voice}
	f.hub.voice = store

	takeOverSameChannel(t, f, obs, a, b)

	if !store.failed.Load() {
		t.Fatal("the roster read never failed: the test does not exercise the rollback")
	}
	if row := f.row(f.uid); row != nil {
		t.Fatalf("a rolled-back join left a row: %+v", row)
	}
	if got := obs.voiceLeaves(f.voiceA, f.uid); got != 1 {
		t.Fatalf("observer saw %d voice_leave frames, want 1; got %s", got, obs.types())
	}
}

// A moderator mute follows a same-channel move into a channel over its cap: the
// slot is kept and the new row is still muted.
func TestMultiDevice_SameChannelMoveIntoOverfullChannelKeepsModeratorMute(t *testing.T) {
	f, obs, a, b := newSameChannelMove(t)
	ctx := context.Background()
	if ok, err := f.hub.voice.SetServerMute(ctx, f.uid, f.voiceA, true); err != nil || !ok {
		t.Fatalf("SetServerMute = %v, %v", ok, err)
	}
	if err := f.db.SetChannelVoiceMaxUsers(ctx, f.voiceA, 1); err != nil {
		t.Fatalf("SetChannelVoiceMaxUsers: %v", err)
	}

	takeOverSameChannel(t, f, obs, a, b)

	row := f.row(f.uid)
	if row == nil || row.ChannelID != f.voiceA {
		t.Fatalf("row after the move = %+v, want one in channel %d; B got %s", row, f.voiceA, b.types())
	}
	if !row.ServerMuted {
		t.Fatal("the moved call came back unmuted")
	}
}

// Another user's join that lands while a same-channel call move is in flight
// finds the channel full: the move never frees the slot it takes over, so the
// channel stays at its limit and the mover keeps the call.
func TestMultiDevice_SameChannelMoveKeepsChannelAtLimit(t *testing.T) {
	f, obs, a, b := newSameChannelMove(t)
	ctx := context.Background()
	const limit = 2 // the mover and the observer
	if err := f.db.SetChannelVoiceMaxUsers(ctx, f.voiceA, limit); err != nil {
		t.Fatalf("SetChannelVoiceMaxUsers: %v", err)
	}
	racer := seedHarvestVoiceUser(t, f.db, "md-racer")
	store := &joinRacesMove{VoiceStore: f.hub.voice, mover: f.uid, racer: racer, chID: f.voiceA, capacity: limit}
	f.hub.voice = store

	takeOverSameChannel(t, f, obs, a, b)

	if !store.raced.Load() {
		t.Fatal("the racing join never ran: the test does not exercise the move")
	}
	if !errors.Is(store.racerErr, service.ErrVoiceChannelFull) {
		t.Fatalf("racing join: err = %v, want %v", store.racerErr, service.ErrVoiceChannelFull)
	}
	if row := f.row(racer); row != nil {
		t.Fatalf("the racing join took a slot: %+v", row)
	}
	if b.sawErrorCode(ErrCodeChannelFull) || b.c.voice.channel() != f.voiceA {
		t.Fatalf("the mover lost the call; B got %s", b.types())
	}
	states, err := f.db.GetChannelVoiceStates(ctx, f.voiceA)
	if err != nil {
		t.Fatalf("GetChannelVoiceStates: %v", err)
	}
	if len(states) != limit {
		t.Fatalf("channel holds %d members, want its limit %d", len(states), limit)
	}
	if obs.sawVoiceLeave(f.voiceA, f.uid) {
		t.Fatal("a successful same-channel move announced a voice_leave")
	}
}

// onStateAfterSlotCleared runs fn once, at the first State read made after the
// old device's call slot is cleared: between the move's leave step and its insert.
type onStateAfterSlotCleared struct {
	VoiceStore
	old *Client
	fn  func()
	ran atomic.Bool
}

func (s *onStateAfterSlotCleared) State(ctx context.Context, userID int64) (*db.VoiceState, error) {
	if s.old.voice.channel() == 0 && s.ran.CompareAndSwap(false, true) {
		s.fn()
	}
	return s.VoiceStore.State(ctx, userID)
}

// A moderator's unmute that lands while a same-channel move is in flight is
// kept: the move does not re-apply the mute it read before.
func TestMultiDevice_SameChannelMoveKeepsAnUnmuteThatLandsMidMove(t *testing.T) {
	f, obs, a, b := newSameChannelMove(t)
	ctx := context.Background()
	if ok, err := f.hub.voice.SetServerMute(ctx, f.uid, f.voiceA, true); err != nil || !ok {
		t.Fatalf("SetServerMute = %v, %v", ok, err)
	}
	var unmuted bool
	store := &onStateAfterSlotCleared{VoiceStore: f.hub.voice, old: a.c, fn: func() {
		unmuted, _, _ = f.hub.SetServerMuteLocked(ctx, f.uid, f.voiceA, false)
	}}
	f.hub.voice = store

	takeOverSameChannel(t, f, obs, a, b)

	if !store.ran.Load() || !unmuted {
		t.Fatalf("the unmute did not land mid-move (ran=%v matched=%v)", store.ran.Load(), unmuted)
	}
	row := f.row(f.uid)
	if row == nil || row.ChannelID != f.voiceA {
		t.Fatalf("row after the move = %+v, want one in channel %d; B got %s", row, f.voiceA, b.types())
	}
	if row.ServerMuted {
		t.Fatal("the move re-applied a mute the moderator had just lifted")
	}
}
