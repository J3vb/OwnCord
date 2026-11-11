package ws

import (
	"context"
	"testing"
)

// A same-channel call move into a channel that is already over its cap must keep
// the slot the user held: the move succeeds and nobody sees the user leave.
func TestMultiDevice_SameChannelMoveIntoOverfullChannelKeepsSlot(t *testing.T) {
	f := newMDFix(t)
	obs := f.observer(f.voiceA)
	a := f.dev("session-a", f.text)
	b := f.dev("session-b", f.text)
	f.join(a, f.voiceA)
	f.join(obs, f.voiceA)
	if err := f.db.SetChannelVoiceMaxUsers(context.Background(), f.voiceA, 1); err != nil {
		t.Fatalf("SetChannelVoiceMaxUsers: %v", err)
	}
	obs.pump()
	obs.got = nil

	f.hub.handleMessage(b.c, voiceFrame(t, "voice_join", "join", map[string]any{"channel_id": f.voiceA}))
	b.settle()
	obs.settle()

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
	f := newMDFix(t)
	obs := f.observer(f.voiceA)
	a := f.dev("session-a", f.text)
	b := f.dev("session-b", f.text)
	f.join(a, f.voiceA)
	f.join(obs, f.voiceA)
	obs.pump()
	obs.got = nil

	// An empty signing secret makes the next token mint fail.
	f.hub.livekit.apiSecret = ""

	f.hub.handleMessage(b.c, voiceFrame(t, "voice_join", "join", map[string]any{"channel_id": f.voiceA}))
	b.settle()
	obs.settle()
	a.settle()

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
