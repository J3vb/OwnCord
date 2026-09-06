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
// store wired at all, and reports applied=false (P3-14: the caller's
// "voice": "applied"/"skipped" must reflect what actually happened).
func TestApplyTimeoutMute_NoVoiceStore(t *testing.T) {
	h := &Hub{}
	if applied, owned := h.ApplyTimeoutMute(context.Background(), 1, 100, "tok", true); applied || owned {
		t.Fatalf("applied=%v owned=%v, want both false: no voice store wired", applied, owned)
	}
}

// TestApplyTimeoutMute_NoSession is a silent no-op for a target with no live
// voice state matching the authorized (channelID, joinedAt) session —
// Timeout's text/reaction restriction still lands regardless — and reports
// applied=false.
func TestApplyTimeoutMute_NoSession(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	h := newTestHub(t, database, nil, nil)
	if applied, owned := h.ApplyTimeoutMute(context.Background(), 999, chID, "no-such-token", true); applied || owned {
		t.Fatalf("applied=%v owned=%v, want both false: no voice_states row for 999", applied, owned)
	}
}

// TestApplyTimeoutMute_SessionMismatch is P1-3 PARTIAL (Codex review round
// 3): the target IS in voice, but not in the exact session (channel or join
// instance) this call was authorized against — a channel switch or a
// leave-and-rejoin race between authorization and this call. The write must
// not follow them there.
func TestApplyTimeoutMute_SessionMismatch(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	uid, err := database.CreateUser(context.Background(), "timedout-mismatch", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	h := newTestHub(t, database, nil, nil)
	if err := h.voice.Join(context.Background(), uid, chID, 0); err != nil {
		t.Fatalf("Join: %v", err)
	}
	if applied, owned := h.ApplyTimeoutMute(context.Background(), uid, chID, "stale-join-token", true); applied || owned {
		t.Fatalf("applied=%v owned=%v, want both false: the join token does not match the live session", applied, owned)
	}
	state, err := h.voice.State(context.Background(), uid)
	if err != nil || state == nil {
		t.Fatalf("State: %v", err)
	}
	if state.ServerMuted {
		t.Fatal("ServerMuted = true, want false: the mismatched-session write must not have landed")
	}
}

// TestApplyTimeoutMute_SFUFailureReportsNotApplied is P3-14 PARTIAL (Codex
// review round 3): a nil h.livekit (this hub's default, matching every
// other ws unit test) makes MuteParticipant fail every time, exactly the
// SFU failure the fix targets — applied must be false even though the DB
// half (CompareAndSetServerMute) already committed successfully. This is
// also the fix for "the ws success test no longer accepts a nil-LiveKit
// case as applied": the old version of this test asserted applied=true
// with a nil livekit, which was only true because the old code tolerated
// an SFU failure silently.
func TestApplyTimeoutMute_SFUFailureReportsNotApplied(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	uid, err := database.CreateUser(context.Background(), "timedout", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	h := newTestHub(t, database, nil, nil)
	if err := h.voice.Join(context.Background(), uid, chID, 0); err != nil {
		t.Fatalf("Join: %v", err)
	}
	state, err := h.voice.State(context.Background(), uid)
	if err != nil || state == nil {
		t.Fatalf("State: %v", err)
	}

	applied, owned := h.ApplyTimeoutMute(context.Background(), uid, chID, state.JoinedAt, true)
	if applied || owned {
		t.Fatalf("applied=%v owned=%v, want both false: h.livekit is nil, so MuteParticipant always fails", applied, owned)
	}
	// The DB half still committed (it runs before the SFU call) — proving
	// this is genuinely an SFU-only failure, not a DB one.
	after, err := h.voice.State(context.Background(), uid)
	if err != nil || after == nil {
		t.Fatalf("State (after): %v", err)
	}
	if !after.ServerMuted {
		t.Fatal("ServerMuted = false, want true: the DB compare-and-mute must still have landed despite the SFU failure")
	}
}

// errorVoiceStore wraps a real VoiceStore and injects failures on State/
// CompareAndSetServerMute, for ApplyTimeoutMute's error-path coverage —
// every other method promotes straight through to the embedded
// implementation.
type errorVoiceStore struct {
	VoiceStore
	stateErr     error
	compareErr   error
	compareMatch bool
	compareOwned bool
}

func (e *errorVoiceStore) State(ctx context.Context, userID int64) (*db.VoiceState, error) {
	if e.stateErr != nil {
		return nil, e.stateErr
	}
	return e.VoiceStore.State(ctx, userID)
}

func (e *errorVoiceStore) CompareAndSetServerMute(ctx context.Context, userID, channelID int64, joinedAt string, muted bool) (bool, bool, error) {
	if e.compareErr != nil {
		return false, false, e.compareErr
	}
	return e.compareMatch, e.compareOwned, nil
}

// TestApplyTimeoutMute_CompareAndSetServerMuteFailed logs and returns rather
// than panicking when the compare-and-mute write itself fails.
func TestApplyTimeoutMute_CompareAndSetServerMuteFailed(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	h := newTestHub(t, database, nil, nil)
	h.voice = &errorVoiceStore{VoiceStore: h.voice, compareErr: errors.New("boom")}
	if applied, owned := h.ApplyTimeoutMute(context.Background(), 1, chID, "tok", true); applied || owned { // must not panic
		t.Fatalf("applied=%v owned=%v, want both false: CompareAndSetServerMute failed", applied, owned)
	}
}

// TestApplyTimeoutMute_CompareAndSetServerMuteNoMatch covers the no-match
// return — the session moved between authorization and this call, so there
// is nothing to mute in the channel that was authorized.
func TestApplyTimeoutMute_CompareAndSetServerMuteNoMatch(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	h := newTestHub(t, database, nil, nil)
	h.voice = &errorVoiceStore{VoiceStore: h.voice, compareMatch: false}
	if applied, owned := h.ApplyTimeoutMute(context.Background(), 1, chID, "tok", true); applied || owned { // must not panic, no broadcast
		t.Fatalf("applied=%v owned=%v, want both false: CompareAndSetServerMute reported no match", applied, owned)
	}
}
