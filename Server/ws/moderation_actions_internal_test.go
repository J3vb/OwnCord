package ws

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// TestWarning_LiveTargetGetsModActionFrame: NotifyModAction reaches a
// connected target directly (SendToUserLow), targeted and unsequenced.
func TestWarning_LiveTargetGetsModActionFrame(t *testing.T) {
	h := newEmitTestHub()
	send := registerEmitTestClient(h, 42, 0)

	h.NotifyModAction(42, 7, "warning", "be nice", nil)

	msgs := drainChan(send, 200*time.Millisecond)
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1: %v", len(msgs), msgs)
	}
	if !bytes.Contains(msgs[0], []byte(`"type":"mod_action"`)) {
		t.Fatalf("frame = %s, want a mod_action frame", msgs[0])
	}
	if !bytes.Contains(msgs[0], []byte(`"kind":"warning"`)) {
		t.Fatalf("frame = %s, want kind=warning", msgs[0])
	}
	if !bytes.Contains(msgs[0], []byte(`"expires_at":null`)) {
		t.Fatalf("frame = %s, want a null expires_at for a warning", msgs[0])
	}
}

// TestTimeout_LiveTargetGetsModActionFrame is the timeout twin: a non-nil
// expires_at rides the same frame.
func TestTimeout_LiveTargetGetsModActionFrame(t *testing.T) {
	h := newEmitTestHub()
	send := registerEmitTestClient(h, 42, 0)

	expires := time.Now().Add(time.Hour)
	h.NotifyModAction(42, 8, "timeout", "cool off", &expires)

	msgs := drainChan(send, 200*time.Millisecond)
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1: %v", len(msgs), msgs)
	}
	if !bytes.Contains(msgs[0], []byte(`"kind":"timeout"`)) {
		t.Fatalf("frame = %s, want kind=timeout", msgs[0])
	}
	if bytes.Contains(msgs[0], []byte(`"expires_at":null`)) {
		t.Fatalf("frame = %s, want a non-null expires_at for an active timeout", msgs[0])
	}
}

// TestWarning_NotifyModAction_NoConnectionIsANoOp: a disconnected target
// simply gets nothing — the warning still surfaces on next connect via
// ready's notices.
func TestWarning_NotifyModAction_NoConnectionIsANoOp(t *testing.T) {
	h := newEmitTestHub()
	// No panic, no error return to check — NotifyModAction has no return
	// value; this only proves it does not block or panic with no client.
	h.NotifyModAction(999, 1, "warning", "x", nil)
}

// applyTimeoutMuteTestDB opens a fully migrated database with one voice
// channel, for ApplyTimeoutMute's tests.
func applyTimeoutMuteTestDB(t *testing.T) (*db.DB, int64) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO channels (id, name, type, position) VALUES (100, 'voice-100', 'voice', 0)`); err != nil {
		t.Fatalf("seed channel: %v", err)
	}
	return database, 100
}

// TestApplyTimeoutMute_NoVoiceStore is a no-op when the hub has no voice
// store wired at all.
func TestApplyTimeoutMute_NoVoiceStore(t *testing.T) {
	h := &Hub{}
	h.ApplyTimeoutMute(context.Background(), 1, true) // must not panic
}

// TestApplyTimeoutMute_NotInVoice is a silent no-op for a target with no
// live voice state — Timeout's text/reaction restriction still lands
// regardless.
func TestApplyTimeoutMute_NotInVoice(t *testing.T) {
	database, _ := applyTimeoutMuteTestDB(t)
	h := newTestHub(t, database, nil, nil)
	h.ApplyTimeoutMute(context.Background(), 999, true) // no voice_states row for 999
}

// TestApplyTimeoutMute_MutesAndBroadcasts applies and then lifts the voice
// half of a timeout on a connected target, through VoiceStore.SetServerMute
// — the same mechanism voice_mod_mute uses — and confirms the persisted
// server_muted flag flips both ways.
func TestApplyTimeoutMute_MutesAndBroadcasts(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	uid, err := database.CreateUser(context.Background(), "timedout", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	h := newTestHub(t, database, nil, nil)
	if err := h.voice.Join(context.Background(), uid, chID, 0); err != nil {
		t.Fatalf("Join: %v", err)
	}

	h.ApplyTimeoutMute(context.Background(), uid, true)
	state, err := h.voice.State(context.Background(), uid)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state == nil || !state.ServerMuted {
		t.Fatalf("state = %+v, want ServerMuted", state)
	}

	h.ApplyTimeoutMute(context.Background(), uid, false)
	state, err = h.voice.State(context.Background(), uid)
	if err != nil {
		t.Fatalf("State (after lift): %v", err)
	}
	if state == nil || state.ServerMuted {
		t.Fatalf("state = %+v, want ServerMuted cleared after the lift", state)
	}
}

// errorVoiceStore wraps a real VoiceStore and injects failures on State/
// SetServerMute, for ApplyTimeoutMute's error-path coverage — every other
// method promotes straight through to the embedded implementation.
type errorVoiceStore struct {
	VoiceStore
	stateErr  error
	muteErr   error
	muteMatch bool
}

func (e *errorVoiceStore) State(ctx context.Context, userID int64) (*db.VoiceState, error) {
	if e.stateErr != nil {
		return nil, e.stateErr
	}
	return e.VoiceStore.State(ctx, userID)
}

func (e *errorVoiceStore) SetServerMute(ctx context.Context, userID, channelID int64, muted bool) (bool, error) {
	if e.muteErr != nil {
		return false, e.muteErr
	}
	return e.muteMatch, nil
}

// TestApplyTimeoutMute_StateLookupFailed logs and returns rather than
// panicking when the voice-state read itself fails.
func TestApplyTimeoutMute_StateLookupFailed(t *testing.T) {
	database, _ := applyTimeoutMuteTestDB(t)
	h := newTestHub(t, database, nil, nil)
	h.voice = &errorVoiceStore{VoiceStore: h.voice, stateErr: errors.New("boom")}
	h.ApplyTimeoutMute(context.Background(), 1, true) // must not panic
}

// TestApplyTimeoutMute_SetServerMuteFailed and
// TestApplyTimeoutMute_SetServerMuteNoMatch cover SetServerMute's error and
// no-match returns — a match failure means the target left (or switched
// channels) between the State read and this write, so there is nothing left
// to mute in the channel that was read.
func TestApplyTimeoutMute_SetServerMuteFailed(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	uid, err := database.CreateUser(context.Background(), "timedout2", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	h := newTestHub(t, database, nil, nil)
	if err := h.voice.Join(context.Background(), uid, chID, 0); err != nil {
		t.Fatalf("Join: %v", err)
	}
	h.voice = &errorVoiceStore{VoiceStore: h.voice, muteErr: errors.New("boom")}
	h.ApplyTimeoutMute(context.Background(), uid, true) // must not panic
}

func TestApplyTimeoutMute_SetServerMuteNoMatch(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	uid, err := database.CreateUser(context.Background(), "timedout3", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	h := newTestHub(t, database, nil, nil)
	if err := h.voice.Join(context.Background(), uid, chID, 0); err != nil {
		t.Fatalf("Join: %v", err)
	}
	h.voice = &errorVoiceStore{VoiceStore: h.voice, muteMatch: false}
	h.ApplyTimeoutMute(context.Background(), uid, true) // must not panic, no broadcast
}
