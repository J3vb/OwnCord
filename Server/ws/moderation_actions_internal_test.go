package ws

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
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
// channel, for MuteForTimeout/UnmuteForTimeout's tests.
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

// seedTimeoutActionForTest inserts a minimal moderation_actions row so
// MuteForTimeout's actionID has a real FK target, and returns its id.
func seedTimeoutActionForTest(t *testing.T, database *db.DB, targetID int64) int64 {
	t.Helper()
	var id int64
	row := database.QueryRowContext(context.Background(),
		`INSERT INTO moderation_actions (kind, target_id, expires_at) VALUES ('timeout', ?, '2999-01-01 00:00:00') RETURNING id`,
		targetID)
	if err := row.Scan(&id); err != nil {
		t.Fatalf("seedTimeoutActionForTest: %v", err)
	}
	return id
}

// TestMuteForTimeout_NoVoiceStore is a no-op when the hub has no voice
// store wired at all, and reports applied=false (P3-14: the caller's
// "voice": "applied"/"skipped" must reflect what actually happened).
func TestMuteForTimeout_NoVoiceStore(t *testing.T) {
	h := &Hub{}
	if applied, owned := h.MuteForTimeout(context.Background(), 1, 100, 1, "tok", nil); applied || owned {
		t.Fatalf("applied=%v owned=%v, want both false: no voice store wired", applied, owned)
	}
}

// TestMuteForTimeout_NoSession is a silent no-op for a target with no live
// voice state matching the authorized (channelID, joinedAt) session —
// Timeout's text/reaction restriction still lands regardless — and reports
// applied=false.
func TestMuteForTimeout_NoSession(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	h := newTestHub(t, database, nil, nil)
	uid, err := database.CreateUser(context.Background(), "no-session-user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	actionID := seedTimeoutActionForTest(t, database, uid)
	if applied, owned := h.MuteForTimeout(context.Background(), uid, chID, actionID, "no-such-token", nil); applied || owned {
		t.Fatalf("applied=%v owned=%v, want both false: no voice_states row for %d", applied, owned, uid)
	}
}

// TestMuteForTimeout_SessionMismatch is P1-3 PARTIAL: the target IS in
// voice, but not in the exact session (channel or join instance) this call
// was authorized against — a channel switch or a leave-and-rejoin race
// between authorization and this call. The write must not follow them
// there.
func TestMuteForTimeout_SessionMismatch(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	uid, err := database.CreateUser(context.Background(), "timedout-mismatch", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	h := newTestHub(t, database, nil, nil)
	actionID := seedTimeoutActionForTest(t, database, uid)
	if err := h.voice.Join(context.Background(), uid, chID, 0); err != nil {
		t.Fatalf("Join: %v", err)
	}
	if applied, owned := h.MuteForTimeout(context.Background(), uid, chID, actionID, "stale-join-token", nil); applied || owned {
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

// TestMuteForTimeout_SFUFailureRollsBackDB is P3-14 PARTIAL, extended for
// round 4's Codex 14: a nil h.livekit (this hub's default, matching every
// other ws unit test) makes MuteParticipant fail every time — applied must
// be false, AND the DB transition that already committed must be rolled
// back under the same lock, so the DB and the (failed) SFU state agree
// again: server_muted=0, server_muted_by=NULL.
func TestMuteForTimeout_SFUFailureRollsBackDB(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	uid, err := database.CreateUser(context.Background(), "timedout", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	h := newTestHub(t, database, nil, nil)
	actionID := seedTimeoutActionForTest(t, database, uid)
	if err := h.voice.Join(context.Background(), uid, chID, 0); err != nil {
		t.Fatalf("Join: %v", err)
	}
	state, err := h.voice.State(context.Background(), uid)
	if err != nil || state == nil {
		t.Fatalf("State: %v", err)
	}

	applied, owned := h.MuteForTimeout(context.Background(), uid, chID, actionID, state.JoinedAt, nil)
	if applied || owned {
		t.Fatalf("applied=%v owned=%v, want both false: h.livekit is nil, so MuteParticipant always fails", applied, owned)
	}
	after, err := h.voice.State(context.Background(), uid)
	if err != nil || after == nil {
		t.Fatalf("State (after): %v", err)
	}
	if after.ServerMuted {
		t.Fatal("ServerMuted = true, want false: an SFU failure must roll the DB transition back (Codex 14)")
	}
	// Directly against the DB row, not just the ws-level State view: the
	// column the rollback promises to clear.
	channelID, joinedAt, cleared, err := database.ClearServerMuteOwnedBy(context.Background(), uid, []int64{actionID})
	if err != nil || cleared {
		t.Fatalf("ClearServerMuteOwnedBy cleared=%v err=%v, want false: server_muted_by must already be NULL after the rollback", cleared, err)
	}
	_, _, _ = channelID, joinedAt, cleared
}

// TestMuteForTimeout_SFUFailureRollsBackDB_SupersedeDuringSFU extends the
// base case above with round 5's remaining named gap: a supersede landing
// WHILE A's own SFU call is in flight, still holding h.voiceMod's per-user
// lock. db.TimeoutUser's ledger write is NOT gated by that lock at all —
// only the voice half is (moderation_action_queries.go's own doc comment) —
// so B's supersede genuinely completes while A is still parked. A's SFU
// call then fails; its rollback (Codex 14) is scoped to exactly its own
// action id and must not disturb anything B's own voice half does
// afterward — which is what finally mutes and owns it.
func TestMuteForTimeout_SFUFailureRollsBackDB_SupersedeDuringSFU(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	ctx := context.Background()
	actorID, err := database.CreateUser(ctx, "supersede-actor", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser(actor): %v", err)
	}
	uid, err := database.CreateUser(ctx, "supersede-target", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(target): %v", err)
	}
	h := newTestHub(t, database, nil, nil)
	if err := h.voice.Join(ctx, uid, chID, 0); err != nil {
		t.Fatalf("Join: %v", err)
	}
	state, err := h.voice.State(ctx, uid)
	if err != nil || state == nil {
		t.Fatalf("State: %v", err)
	}

	actionA, _, err := database.TimeoutUser(ctx, uid, actorID, nil, "A", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("TimeoutUser(A): %v", err)
	}

	// Parks A's SFU call — still holding h.voiceMod's per-user lock — until
	// the supersede below has run, then fails it.
	parked := make(chan struct{})
	release := make(chan struct{})
	prevHook := muteParticipantHookForTest
	muteParticipantHookForTest = func(context.Context, int64, int64, string, bool) error {
		close(parked)
		<-release
		return errors.New("sfu failure")
	}
	t.Cleanup(func() { muteParticipantHookForTest = prevHook })

	type result struct{ applied, owned bool }
	aDone := make(chan result, 1)
	go func() {
		applied, owned := h.MuteForTimeout(ctx, uid, chID, actionA, state.JoinedAt, nil)
		aDone <- result{applied, owned}
	}()

	select {
	case <-parked:
	case <-time.After(2 * time.Second):
		t.Fatal("A's MuteForTimeout never reached its SFU call")
	}

	// B supersedes A while A's SFU call is still in flight, still holding
	// the lock — the ledger write is not gated by h.voiceMod at all.
	actionB, supersededIDs, err := database.TimeoutUser(ctx, uid, actorID, nil, "B", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("TimeoutUser(B): %v", err)
	}
	if len(supersededIDs) != 1 || supersededIDs[0] != actionA {
		t.Fatalf("supersededIDs = %v, want [%d]", supersededIDs, actionA)
	}

	close(release)
	var aResult result
	select {
	case aResult = <-aDone:
	case <-time.After(2 * time.Second):
		t.Fatal("A's MuteForTimeout never completed after being released")
	}
	if aResult.applied || aResult.owned {
		t.Fatalf("A: applied=%v owned=%v, want both false: its SFU call fails", aResult.applied, aResult.owned)
	}

	// A's rollback must be scoped to exactly its own action id.
	after, err := h.voice.State(ctx, uid)
	if err != nil || after == nil || after.ServerMuted {
		t.Fatal("ServerMuted = true after A's rollback, want false")
	}
	if _, _, cleared, err := database.ClearServerMuteOwnedBy(ctx, uid, []int64{actionA}); err != nil || cleared {
		t.Fatalf("ClearServerMuteOwnedBy(A) cleared=%v err=%v, want false: A's own rollback must already have cleared it", cleared, err)
	}

	// B's own voice half now runs (as service.applyTimeoutVoiceHalf would,
	// passing the supersededIDs TimeoutUser returned) and must mute and own
	// it, undisturbed by A's failed, already-rolled-back attempt.
	muteParticipantHookForTest = func(context.Context, int64, int64, string, bool) error { return nil }
	bApplied, bOwned := h.MuteForTimeout(ctx, uid, chID, actionB, state.JoinedAt, supersededIDs)
	if !bApplied || !bOwned {
		t.Fatalf("B: applied=%v owned=%v, want both true: B's voice half must mute and own it after A's failure", bApplied, bOwned)
	}
	final, err := h.voice.State(ctx, uid)
	if err != nil || final == nil || !final.ServerMuted {
		t.Fatal("ServerMuted = false after B's mute, want true")
	}
	if _, _, cleared, err := database.ClearServerMuteOwnedBy(ctx, uid, []int64{actionB}); err != nil || !cleared {
		t.Fatalf("ClearServerMuteOwnedBy(B) cleared=%v err=%v, want true: B must own the final mute", cleared, err)
	}
}

// errorVoiceStore wraps a real VoiceStore and injects failures on State/
// MuteForTimeoutSession/ClearServerMuteOwnedBy, for MuteForTimeout/
// UnmuteForTimeout's error-path coverage — every other method promotes
// straight through to the embedded implementation.
type errorVoiceStore struct {
	VoiceStore
	stateErr   error
	muteErr    error
	muteMatch  bool
	muteOwned  bool
	clearErr   error
	clearMatch bool
}

func (e *errorVoiceStore) State(ctx context.Context, userID int64) (*db.VoiceState, error) {
	if e.stateErr != nil {
		return nil, e.stateErr
	}
	return e.VoiceStore.State(ctx, userID)
}

func (e *errorVoiceStore) MuteForTimeoutSession(ctx context.Context, userID, channelID, actionID int64, joinedAt string, supersededIDs []int64) (bool, bool, error) {
	if e.muteErr != nil {
		return false, false, e.muteErr
	}
	return e.muteMatch, e.muteOwned, nil
}

func (e *errorVoiceStore) ClearServerMuteOwnedBy(ctx context.Context, userID int64, actionIDs []int64) (int64, string, bool, error) {
	if e.clearErr != nil {
		return 0, "", false, e.clearErr
	}
	return 0, "", e.clearMatch, nil
}

// TestMuteForTimeout_MuteForTimeoutSessionFailed logs and returns rather
// than panicking when the DB write itself fails.
func TestMuteForTimeout_MuteForTimeoutSessionFailed(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	h := newTestHub(t, database, nil, nil)
	h.voice = &errorVoiceStore{VoiceStore: h.voice, muteErr: errors.New("boom")}
	if applied, owned := h.MuteForTimeout(context.Background(), 1, chID, 1, "tok", nil); applied || owned { // must not panic
		t.Fatalf("applied=%v owned=%v, want both false: MuteForTimeoutSession failed", applied, owned)
	}
}

// TestMuteForTimeout_MuteForTimeoutSessionNoMatch covers the no-match
// return — the session moved between authorization and this call, so there
// is nothing to mute in the channel that was authorized.
func TestMuteForTimeout_MuteForTimeoutSessionNoMatch(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	h := newTestHub(t, database, nil, nil)
	h.voice = &errorVoiceStore{VoiceStore: h.voice, muteMatch: false}
	if applied, owned := h.MuteForTimeout(context.Background(), 1, chID, 1, "tok", nil); applied || owned { // must not panic, no broadcast
		t.Fatalf("applied=%v owned=%v, want both false: MuteForTimeoutSession reported no match", applied, owned)
	}
}

// TestMuteForTimeout_BroadcastSkippedOnStateReadFailure covers
// broadcastVoiceMuteState's own defensive read failure — the mute itself
// must still report applied even when the follow-up broadcast read errors.
func TestMuteForTimeout_BroadcastSkippedOnStateReadFailure(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	h := newTestHub(t, database, nil, nil)
	h.voice = &errorVoiceStore{VoiceStore: h.voice, muteMatch: true, muteOwned: true, stateErr: errors.New("boom")}
	prevHook := muteParticipantHookForTest
	muteParticipantHookForTest = func(context.Context, int64, int64, string, bool) error { return nil }
	t.Cleanup(func() { muteParticipantHookForTest = prevHook })

	applied, owned := h.MuteForTimeout(context.Background(), 1, chID, 1, "tok", nil)
	if !applied || !owned { // must not panic despite the broadcast's State() failing
		t.Fatalf("applied=%v owned=%v, want both true: the mute itself succeeded", applied, owned)
	}
}

// TestSetServerMuteLocked_NoMatch covers the manual-mute path's own
// no-match return: no voice_states row for the target at all.
func TestSetServerMuteLocked_NoMatch(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	h := newTestHub(t, database, nil, nil)
	matched, joinedAt, err := h.SetServerMuteLocked(context.Background(), 999, chID, true)
	if err != nil || matched || joinedAt != "" {
		t.Fatalf("matched=%v joinedAt=%q err=%v, want matched=false joinedAt=\"\" err=nil: no session for 999", matched, joinedAt, err)
	}
}

// TestMuteForTimeout_AlreadyMuted covers matched=true, transitioned=false:
// applied without owning it — nothing new for the SFU, so no MuteParticipant
// call and no broadcast.
func TestMuteForTimeout_AlreadyMuted(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	h := newTestHub(t, database, nil, nil)
	h.voice = &errorVoiceStore{VoiceStore: h.voice, muteMatch: true, muteOwned: false}
	applied, owned := h.MuteForTimeout(context.Background(), 1, chID, 1, "tok", nil)
	if !applied || owned {
		t.Fatalf("applied=%v owned=%v, want applied=true owned=false: already muted by someone/something else", applied, owned)
	}
}

// TestMuteForTimeout_RollbackFailureIsLoggedNotPanicked covers the SFU
// failure path's own rollback failing — must log and return, not panic.
func TestMuteForTimeout_RollbackFailureIsLoggedNotPanicked(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	h := newTestHub(t, database, nil, nil)
	h.voice = &errorVoiceStore{VoiceStore: h.voice, muteMatch: true, muteOwned: true, clearErr: errors.New("rollback boom")}
	// h.livekit is nil, so MuteParticipant fails, triggering the rollback.
	if applied, owned := h.MuteForTimeout(context.Background(), 1, chID, 1, "tok", nil); applied || owned {
		t.Fatalf("applied=%v owned=%v, want both false: SFU failure, even with a failing rollback", applied, owned)
	}
}

// TestUnmuteForTimeout_NoActionIDs is a no-op — LiftTimeout found nothing
// active to lift, so there is no ownership chain to clear against.
func TestUnmuteForTimeout_NoActionIDs(t *testing.T) {
	database, _ := applyTimeoutMuteTestDB(t)
	h := newTestHub(t, database, nil, nil)
	if got := h.UnmuteForTimeout(context.Background(), 1, nil); got {
		t.Fatal("UnmuteForTimeout(nil ids) = true, want false")
	}
}

// TestUnmuteForTimeout_ClearServerMuteOwnedByFailed logs and returns rather
// than panicking when the DB clear itself fails.
func TestUnmuteForTimeout_ClearServerMuteOwnedByFailed(t *testing.T) {
	database, _ := applyTimeoutMuteTestDB(t)
	h := newTestHub(t, database, nil, nil)
	h.voice = &errorVoiceStore{VoiceStore: h.voice, clearErr: errors.New("boom")}
	if got := h.UnmuteForTimeout(context.Background(), 1, []int64{1}); got {
		t.Fatal("UnmuteForTimeout = true, want false: ClearServerMuteOwnedBy failed")
	}
}

// TestUnmuteForTimeout_SFUFailureStillClearsDB proves the unmute side's
// best-effort SFU tolerance (round 4): a genuine ownership match with
// h.livekit unconfigured (MuteParticipant always fails here) still reports
// applied and leaves the DB cleared — the DB row is not rolled back the way
// MuteForTimeout's fresh mute is, matching voice_mod_mute's own posture.
func TestUnmuteForTimeout_SFUFailureStillClearsDB(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	uid, err := database.CreateUser(context.Background(), "unmute-sfu-fail-user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	h := newTestHub(t, database, nil, nil)
	actionID := seedTimeoutActionForTest(t, database, uid)
	if err := h.voice.Join(context.Background(), uid, chID, 0); err != nil {
		t.Fatalf("Join: %v", err)
	}
	state, err := h.voice.State(context.Background(), uid)
	if err != nil || state == nil {
		t.Fatalf("State: %v", err)
	}
	prevHook := muteParticipantHookForTest
	muteParticipantHookForTest = func(context.Context, int64, int64, string, bool) error { return nil }
	applied, owned := h.MuteForTimeout(context.Background(), uid, chID, actionID, state.JoinedAt, nil)
	muteParticipantHookForTest = prevHook
	if !applied || !owned {
		t.Fatalf("seed mute: applied=%v owned=%v", applied, owned)
	}

	if got := h.UnmuteForTimeout(context.Background(), uid, []int64{actionID}); !got {
		t.Fatal("UnmuteForTimeout = false, want true: the DB clear must still count even if the SFU call fails")
	}
	final, err := h.voice.State(context.Background(), uid)
	if err != nil || final == nil || final.ServerMuted {
		t.Fatal("ServerMuted must be false: the DB half is not rolled back on an unmute's SFU failure")
	}
}

// TestUnmuteForTimeout_ManualMuteNeverCleared proves migration 049's
// server_muted_by-NULL immunity through the Hub's own methods (round 4,
// Part A): a manual moderator mute (voice_mod_mute) is never touched by a
// timeout's lift, no matter which action ids it names.
func TestUnmuteForTimeout_ManualMuteNeverCleared(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	uid, err := database.CreateUser(context.Background(), "manual-mute-user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	h := newTestHub(t, database, nil, nil)
	actionID := seedTimeoutActionForTest(t, database, uid)
	if err := h.voice.Join(context.Background(), uid, chID, 0); err != nil {
		t.Fatalf("Join: %v", err)
	}
	if matched, _, err := h.SetServerMuteLocked(context.Background(), uid, chID, true); err != nil || !matched {
		t.Fatalf("SetServerMuteLocked: matched=%v err=%v", matched, err)
	}

	if got := h.UnmuteForTimeout(context.Background(), uid, []int64{actionID}); got {
		t.Fatal("UnmuteForTimeout cleared a manual mute it does not own")
	}
	state, err := h.voice.State(context.Background(), uid)
	if err != nil || state == nil || !state.ServerMuted {
		t.Fatal("the manual mute must still be in effect")
	}
}

// TestHandleVoiceModMuteV2_ModLessDepsFallsBackToUnlockedWrite covers the
// non-locker fallback (round 4, Codex review Part B): a Mod-less deps
// (never wired in production — NewHub's Mod is always the Hub itself, a
// locker) still gets the DB write done, exactly as it did before the lock
// existed, just without the paired SFU call or the lock.
func TestHandleVoiceModMuteV2_ModLessDepsFallsBackToUnlockedWrite(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	ctx := context.Background()
	actorID, err := database.CreateUser(ctx, "modless-actor", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser(actor): %v", err)
	}
	targetID, err := database.CreateUser(ctx, "modless-target", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(target): %v", err)
	}
	h := newTestHub(t, database, nil, nil)
	if err := h.voice.Join(ctx, targetID, chID, 0); err != nil {
		t.Fatalf("Join: %v", err)
	}

	deps := VoiceDeps{Voice: h.voice, Reader: database, Permissions: permissions.NewChecker(database)}
	cmd := VoiceModMuteCmd{userID: actorID, channelID: chID, targetID: targetID, muted: true}
	res := handleVoiceModMuteV2(ctx, cmd, ClientInfo{UserID: actorID}, deps)
	if res.Error != nil {
		t.Fatalf("handleVoiceModMuteV2: %+v", res.Error)
	}
	state, err := h.voice.State(ctx, targetID)
	if err != nil || state == nil || !state.ServerMuted {
		t.Fatal("ServerMuted must be true: the DB write must still land with no Mod wired")
	}
}

// TestMuteForTimeout_ContendsOnTheHubLock is round 5's Codex review test
// partial: TestVoiceModLock_StaleUnmuteNeverClearsAFreshReclaim only ever
// runs its two paths sequentially, which proves the ownership model's
// correctness but nothing about whether MuteForTimeout genuinely takes
// h.voiceMod at all. This parks the target's lock directly, starts
// MuteForTimeout in a goroutine, and asserts it is still blocked a moment
// later — real contention on the Hub's own lock, not a doc comment's claim.
func TestMuteForTimeout_ContendsOnTheHubLock(t *testing.T) {
	database, chID := applyTimeoutMuteTestDB(t)
	uid, err := database.CreateUser(context.Background(), "lock-contend-user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	h := newTestHub(t, database, nil, nil)
	ctx := context.Background()
	if err := h.voice.Join(ctx, uid, chID, 0); err != nil {
		t.Fatalf("Join: %v", err)
	}
	actionID := seedTimeoutActionForTest(t, database, uid)

	unlock := h.voiceMod.lock(uid)

	done := make(chan struct{})
	go func() {
		h.MuteForTimeout(ctx, uid, chID, actionID, "tok", nil)
		close(done)
	}()

	select {
	case <-done:
		t.Fatal("MuteForTimeout completed while the per-user lock was held by the test goroutine")
	case <-time.After(100 * time.Millisecond):
		// Expected: still blocked.
	}

	unlock()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("MuteForTimeout never completed after the lock was released")
	}
}

// TestVoiceModLocks_SerializesSameUser proves voiceModLocks' core contract
// (round 4, Codex 12): two callers for the SAME userID cannot both be inside
// their critical section at once — the second's lock() call genuinely
// blocks until the first releases. Deterministic (no sleeps): the second
// goroutine signals it is about to call lock(), then the test asserts it has
// NOT yet reported "acquired" a short, generous instant later, before
// releasing the first and confirming the second then proceeds.
func TestVoiceModLocks_SerializesSameUser(t *testing.T) {
	v := newVoiceModLocks()
	const uid = int64(1)

	firstAcquired := make(chan struct{})
	releaseFirst := make(chan struct{})
	go func() {
		unlock := v.lock(uid)
		close(firstAcquired)
		<-releaseFirst
		unlock()
	}()
	<-firstAcquired

	secondAttempting := make(chan struct{})
	secondAcquired := make(chan struct{})
	go func() {
		close(secondAttempting)
		unlock := v.lock(uid)
		close(secondAcquired)
		unlock()
	}()
	<-secondAttempting

	select {
	case <-secondAcquired:
		t.Fatal("second lock() returned while the first still holds it")
	case <-time.After(50 * time.Millisecond):
		// Expected: still blocked.
	}

	close(releaseFirst)
	select {
	case <-secondAcquired:
	case <-time.After(2 * time.Second):
		t.Fatal("second lock() never returned after the first released")
	}
}

// TestVoiceModLocks_DoesNotSerializeDifferentUsers proves the lock is keyed
// per userID, not a single global lock — a moderation action against one
// user must not stall on an unrelated one.
func TestVoiceModLocks_DoesNotSerializeDifferentUsers(t *testing.T) {
	v := newVoiceModLocks()
	unlock1 := v.lock(1)
	defer unlock1()

	done := make(chan struct{})
	go func() {
		unlock2 := v.lock(2)
		unlock2()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("lock(2) blocked on an unrelated user's held lock(1)")
	}
}

// TestVoiceModLocks_EvictsEntryOnceUnheldAndUnwaited is round 5's Codex
// review P3: the per-target map must not grow forever — an entry with no
// current holder and no queued waiter is removed as soon as the last
// release happens, not kept around indefinitely.
func TestVoiceModLocks_EvictsEntryOnceUnheldAndUnwaited(t *testing.T) {
	v := newVoiceModLocks()

	unlock := v.lock(1)
	if len(v.locks) != 1 {
		t.Fatalf("locks = %d entries while held, want 1", len(v.locks))
	}
	unlock()
	if len(v.locks) != 0 {
		t.Fatalf("locks = %d entries after the only holder released, want 0 (evicted)", len(v.locks))
	}

	// A waiter queued behind an in-flight holder must NOT be evicted out
	// from under it: refs stays at 2 (holder + waiter) until both release.
	unlockA := v.lock(2)
	waiterStarted := make(chan struct{})
	waiterDone := make(chan struct{})
	go func() {
		close(waiterStarted)
		v.lock(2)() // blocks until unlockA runs, then immediately releases
		close(waiterDone)
	}()
	<-waiterStarted
	// Give the waiter a moment to register itself (increment refs) before
	// the holder releases — best-effort, like the existing contention test
	// above; the correctness claim (refs never hits 0 while a waiter is
	// registered) holds regardless of exactly when it gets there.
	time.Sleep(20 * time.Millisecond)
	unlockA()
	select {
	case <-waiterDone:
	case <-time.After(2 * time.Second):
		t.Fatal("the queued waiter for user 2 never completed")
	}
	if len(v.locks) != 0 {
		t.Fatalf("locks = %d entries after both the holder and the waiter released, want 0 (evicted)", len(v.locks))
	}
}

// TestVoiceModLock_StaleUnmuteNeverClearsAFreshReclaim exercises the "X
// lifts while Y's timeout mutes" scenario (round 4's reshape of
// TestTimeout_VoiceHalf_StrandedMuteCompensated, Codex 12) through the
// Hub's own MuteForTimeout/UnmuteForTimeout, run SEQUENTIALLY in both
// possible orders (exhaustive rather than one flaky race): X already owns
// a live mute; X's ledger row is then marked lifted (simulating
// db.LiftTimeout having already run, exactly as service.LiftTimeout always
// calls it before ever reaching the voice muter); a fresh timeout Y mutes
// the same target. Whichever of {X's unmute, Y's mute} runs first, the
// final state is muted, owned by Y, and the recorded SFU calls never end on
// an unmute (the DB and the SFU must agree).
func TestVoiceModLock_StaleUnmuteNeverClearsAFreshReclaim(t *testing.T) {
	for _, order := range []string{"unmute-then-mute", "mute-then-unmute"} {
		t.Run(order, func(t *testing.T) {
			database, chID := applyTimeoutMuteTestDB(t)
			uid, err := database.CreateUser(context.Background(), "race-user-"+order, "hash", 4)
			if err != nil {
				t.Fatalf("CreateUser: %v", err)
			}
			h := newTestHub(t, database, nil, nil)
			ctx := context.Background()
			if err := h.voice.Join(ctx, uid, chID, 0); err != nil {
				t.Fatalf("Join: %v", err)
			}
			state, err := h.voice.State(ctx, uid)
			if err != nil || state == nil {
				t.Fatalf("State: %v", err)
			}

			var sfuLog []string
			prevHook := muteParticipantHookForTest
			muteParticipantHookForTest = func(_ context.Context, _, _ int64, _ string, muted bool) error {
				if muted {
					sfuLog = append(sfuLog, "mute")
				} else {
					sfuLog = append(sfuLog, "unmute")
				}
				return nil
			}
			t.Cleanup(func() { muteParticipantHookForTest = prevHook })

			actionX := seedTimeoutActionForTest(t, database, uid)
			if applied, owned := h.MuteForTimeout(ctx, uid, chID, actionX, state.JoinedAt, nil); !applied || !owned {
				t.Fatalf("seed mute by X: applied=%v owned=%v", applied, owned)
			}
			// X is lifted (db.LiftTimeout already ran, ledger-side) before
			// its voice-muter call is ever made — exactly the service-layer
			// order (db write, then the voiceMuter call afterward).
			if _, err := database.ExecContext(ctx, `UPDATE moderation_actions SET lifted_at = datetime('now') WHERE id = ?`, actionX); err != nil {
				t.Fatalf("mark X lifted: %v", err)
			}
			actionY := seedTimeoutActionForTest(t, database, uid)
			sfuLog = nil // only the race's own calls matter from here

			run := map[string]func(){
				"unmute-then-mute": func() {
					h.UnmuteForTimeout(ctx, uid, []int64{actionX})
					h.MuteForTimeout(ctx, uid, chID, actionY, state.JoinedAt, nil)
				},
				"mute-then-unmute": func() {
					h.MuteForTimeout(ctx, uid, chID, actionY, state.JoinedAt, nil)
					h.UnmuteForTimeout(ctx, uid, []int64{actionX})
				},
			}[order]
			run()

			final, err := h.voice.State(ctx, uid)
			if err != nil || final == nil || !final.ServerMuted {
				t.Fatalf("final state must be muted (order=%s)", order)
			}
			if _, _, cleared, err := database.ClearServerMuteOwnedBy(ctx, uid, []int64{actionY}); err != nil || !cleared {
				t.Fatalf("ClearServerMuteOwnedBy(Y) cleared=%v err=%v, want true: Y must own the final mute (order=%s)", cleared, err, order)
			}
			if len(sfuLog) == 0 || sfuLog[len(sfuLog)-1] != "mute" {
				t.Fatalf("sfuLog = %v, want to end on \"mute\": the SFU must agree with the DB (order=%s)", sfuLog, order)
			}
		})
	}
}

// TestVoiceModLock_StaleUnmuteNeverClearsAFreshReclaim_GenuineContention
// promotes the sequential test above to real contention on h.voiceMod, the
// coordinator's own named gap: TestVoiceModLock_StaleUnmuteNeverClearsAFreshReclaim
// runs its two calls one after the other on the SAME goroutine, which proves
// the ownership model's correctness but nothing about whether the two
// genuinely serialize on the lock rather than merely happening to be invoked
// in that order. Using TestMuteForTimeout_ContendsOnTheHubLock's parking
// pattern, this starts the first call in its own goroutine and parks it mid
// SFU-call (inside MuteParticipant, still holding h.voiceMod's per-user
// lock) via muteParticipantHookForTest, starts the second call in a second
// goroutine, and asserts it is STILL BLOCKED a moment later before releasing
// the first — real contention, not a doc comment's claim — then checks the
// same final invariants the sequential test does: muted, owned by Y, and the
// SFU log ends on "mute" regardless of which call actually ran first.
func TestVoiceModLock_StaleUnmuteNeverClearsAFreshReclaim_GenuineContention(t *testing.T) {
	for _, order := range []string{"unmute-then-mute", "mute-then-unmute"} {
		t.Run(order, func(t *testing.T) {
			database, chID := applyTimeoutMuteTestDB(t)
			uid, err := database.CreateUser(context.Background(), "race-contend-user-"+order, "hash", 4)
			if err != nil {
				t.Fatalf("CreateUser: %v", err)
			}
			h := newTestHub(t, database, nil, nil)
			ctx := context.Background()
			if err := h.voice.Join(ctx, uid, chID, 0); err != nil {
				t.Fatalf("Join: %v", err)
			}
			state, err := h.voice.State(ctx, uid)
			if err != nil || state == nil {
				t.Fatalf("State: %v", err)
			}

			prevHook := muteParticipantHookForTest
			muteParticipantHookForTest = func(context.Context, int64, int64, string, bool) error { return nil }
			t.Cleanup(func() { muteParticipantHookForTest = prevHook })

			actionX := seedTimeoutActionForTest(t, database, uid)
			if applied, owned := h.MuteForTimeout(ctx, uid, chID, actionX, state.JoinedAt, nil); !applied || !owned {
				t.Fatalf("seed mute by X: applied=%v owned=%v", applied, owned)
			}
			// X is lifted (db.LiftTimeout already ran, ledger-side) before its
			// voice-muter call is ever made — the same service-layer order the
			// sequential test pins.
			if _, err := database.ExecContext(ctx, `UPDATE moderation_actions SET lifted_at = datetime('now') WHERE id = ?`, actionX); err != nil {
				t.Fatalf("mark X lifted: %v", err)
			}
			actionY := seedTimeoutActionForTest(t, database, uid)

			// From here, the hook parks whichever call reaches MuteParticipant
			// first — still holding h.voiceMod's per-user lock — until
			// releaseFirst closes, and logs every SFU call's direction.
			var sfuMu sync.Mutex
			var sfuLog []string
			first := true
			firstEntered := make(chan struct{})
			releaseFirst := make(chan struct{})
			muteParticipantHookForTest = func(_ context.Context, _, _ int64, _ string, muted bool) error {
				sfuMu.Lock()
				if muted {
					sfuLog = append(sfuLog, "mute")
				} else {
					sfuLog = append(sfuLog, "unmute")
				}
				isFirst := first
				first = false
				sfuMu.Unlock()
				if isFirst {
					close(firstEntered)
					<-releaseFirst
				}
				return nil
			}

			var firstCall, secondCall func()
			if order == "unmute-then-mute" {
				firstCall = func() { h.UnmuteForTimeout(ctx, uid, []int64{actionX}) }
				secondCall = func() { h.MuteForTimeout(ctx, uid, chID, actionY, state.JoinedAt, nil) }
			} else {
				firstCall = func() { h.MuteForTimeout(ctx, uid, chID, actionY, state.JoinedAt, nil) }
				secondCall = func() { h.UnmuteForTimeout(ctx, uid, []int64{actionX}) }
			}

			firstDone := make(chan struct{})
			go func() {
				firstCall()
				close(firstDone)
			}()
			select {
			case <-firstEntered:
			case <-time.After(2 * time.Second):
				t.Fatal("the first call never reached its SFU call")
			}

			secondDone := make(chan struct{})
			go func() {
				secondCall()
				close(secondDone)
			}()
			select {
			case <-secondDone:
				t.Fatal("the second call completed while the first still held h.voiceMod mid-SFU-call")
			case <-time.After(100 * time.Millisecond):
				// Expected: genuinely blocked on the per-user lock.
			}

			close(releaseFirst)
			select {
			case <-firstDone:
			case <-time.After(2 * time.Second):
				t.Fatal("the first call never completed after being released")
			}
			select {
			case <-secondDone:
			case <-time.After(2 * time.Second):
				t.Fatal("the second call never completed after the lock was released")
			}

			final, err := h.voice.State(ctx, uid)
			if err != nil || final == nil || !final.ServerMuted {
				t.Fatalf("final state must be muted (order=%s)", order)
			}
			if _, _, cleared, err := database.ClearServerMuteOwnedBy(ctx, uid, []int64{actionY}); err != nil || !cleared {
				t.Fatalf("ClearServerMuteOwnedBy(Y) cleared=%v err=%v, want true: Y must own the final mute (order=%s)", cleared, err, order)
			}
			sfuMu.Lock()
			endsOnMute := len(sfuLog) > 0 && sfuLog[len(sfuLog)-1] == "mute"
			gotLog := append([]string(nil), sfuLog...)
			sfuMu.Unlock()
			if !endsOnMute {
				t.Fatalf("sfuLog = %v, want to end on \"mute\": the SFU must agree with the DB (order=%s)", gotLog, order)
			}
		})
	}
}
