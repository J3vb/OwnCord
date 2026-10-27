package ws

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

type rosterFixture struct {
	h          *Hub
	database   *db.DB
	chID       int64
	alice, bob int64
	bobSend    chan []byte
	aliceSend  chan []byte
}

// newRosterFixture seeds a hub with two connected users and a channel standing
// in for the DM's call room (the roster read is keyed by channel id only).
func newRosterFixture(t *testing.T) *rosterFixture {
	t.Helper()
	database := newHarvestVoiceDB(t)
	f := &rosterFixture{
		database:  database,
		alice:     seedHarvestVoiceUser(t, database, "roster-alice"),
		bob:       seedHarvestVoiceUser(t, database, "roster-bob"),
		chID:      mustCreateVoiceChannel(t, database, "roster-room"),
		bobSend:   make(chan []byte, 32),
		aliceSend: make(chan []byte, 32),
	}
	f.h = newTestHubWith(t, HubOptions{DB: database})
	for uid, send := range map[int64]chan []byte{f.alice: f.aliceSend, f.bob: f.bobSend} {
		c := NewTestClient(f.h, uid, send)
		f.h.mu.Lock()
		f.h.clients[uid] = []*Client{c}
		f.h.mu.Unlock()
	}
	return f
}

type rosterFrame struct {
	Type    string `json:"type"`
	Seq     uint64 `json:"seq"`
	Payload struct {
		ChannelID int64 `json:"channel_id"`
		UserID    int64 `json:"user_id"`
	} `json:"payload"`
}

func rosterFrames(t *testing.T, ch chan []byte) []rosterFrame {
	t.Helper()
	raws := drainChan(ch, 200*time.Millisecond)
	out := make([]rosterFrame, 0, len(raws))
	for _, raw := range raws {
		var fr rosterFrame
		if err := json.Unmarshal(raw, &fr); err != nil {
			t.Fatalf("decode frame: %v", err)
		}
		out = append(out, fr)
	}
	return out
}

func TestSendDMVoiceRoster_SequencedStatesToTargetOnly(t *testing.T) {
	f := newRosterFixture(t)
	ctx := context.Background()
	if err := f.database.JoinVoiceChannel(ctx, f.alice, f.chID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	f.h.SendDMVoiceRoster(ctx, f.bob, f.chID)

	frames := rosterFrames(t, f.bobSend)
	if len(frames) != 1 {
		t.Fatalf("bob got %d frames, want 1", len(frames))
	}
	fr := frames[0]
	if fr.Type != "voice_state" || fr.Seq == 0 || fr.Payload.ChannelID != f.chID || fr.Payload.UserID != f.alice {
		t.Errorf("frame = %+v, want sequenced voice_state for alice in %d", fr, f.chID)
	}
	if got := rosterFrames(t, f.aliceSend); len(got) != 0 {
		t.Errorf("alice got %d frames, want none", len(got))
	}
}

func TestSendDMVoiceRoster_EmptyRoomSendsNothing(t *testing.T) {
	f := newRosterFixture(t)
	f.h.SendDMVoiceRoster(context.Background(), f.bob, f.chID)
	if got := rosterFrames(t, f.bobSend); len(got) != 0 {
		t.Errorf("bob got %d frames for an empty call, want none", len(got))
	}
}

func TestSendDMVoiceRoster_SkipsTargetsOwnState(t *testing.T) {
	f := newRosterFixture(t)
	ctx := context.Background()
	if err := f.database.JoinVoiceChannel(ctx, f.bob, f.chID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	f.h.SendDMVoiceRoster(ctx, f.bob, f.chID)
	if got := rosterFrames(t, f.bobSend); len(got) != 0 {
		t.Errorf("bob got %d frames, want none (only his own state)", len(got))
	}
}

type failingStatesVoice struct{ VoiceStore }

func (failingStatesVoice) ChannelStates(context.Context, int64) ([]db.VoiceState, error) {
	return nil, errors.New("boom")
}

func TestSendDMVoiceRoster_ReadFailureSendsNothing(t *testing.T) {
	f := newRosterFixture(t)
	f.h.voice = failingStatesVoice{VoiceStore: f.h.voice}
	f.h.SendDMVoiceRoster(context.Background(), f.bob, f.chID)
	if got := rosterFrames(t, f.bobSend); len(got) != 0 {
		t.Errorf("bob got %d frames after a failed read, want none", len(got))
	}
}
