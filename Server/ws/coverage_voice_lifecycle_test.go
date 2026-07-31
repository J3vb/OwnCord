package ws_test

// coverage_voice_lifecycle_test.go: voice token refresh, rollback, leave
// retry, cleanup, and stale-state sweep coverage tests (split from
// coverage_boost_test.go).

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/owncord/server/permissions"
	"github.com/owncord/server/ws"
)

// ─── voice_token_refresh (now V2 — dispatched via handleMessage) ────────────

func TestHandleVoiceTokenRefresh_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vtr-notinvoice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceTokenRefreshMsg())
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleVoiceTokenRefresh_InVoice_ReturnsToken(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vtr-invc")
	vcID := seedVoiceChannel(t, database, "vtr-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": vcID},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(100 * time.Millisecond)
	drainChanBuf(send)

	hub.HandleMessageForTest(c, voiceTokenRefreshMsg())
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	foundToken := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_token" {
			foundToken = true
			break
		}
	}
	if !foundToken {
		t.Error("expected voice_token message after token refresh")
	}
}

func TestHandleVoiceTokenRefresh_NilUser(t *testing.T) {
	hub, database := newCoverageHub(t)
	// The client deliberately carries no *db.User — that is what this test
	// covers — but the row must exist so the CONNECT_VOICE re-check can resolve
	// a role. Without it the handler stops at FORBIDDEN and never reaches the
	// missing-voice-state branch under test.
	user := seedCoverageOwner(t, database, "vtr-nil-user")
	send := make(chan []byte, 16)
	c := ws.NewTestClient(hub, user.ID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	ws.SetVoiceChIDForTest(c, 42)

	hub.HandleMessageForTest(c, voiceTokenRefreshMsg())
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "INTERNAL" {
		t.Errorf("error code = %q, want INTERNAL", code)
	}
}

// ─── rollbackVoiceJoin (voice_join.go:239) ──────────────────────────────────

func TestRollbackVoiceJoin_ClearsVoiceStateAndBroadcasts(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "rb-user")
	vcID := seedVoiceChannel(t, database, "rb-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	if err := database.JoinVoiceChannel(context.Background(), user.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	ws.SetVoiceChIDForTest(c, vcID)

	hub.RollbackVoiceJoinForTest(c, vcID)
	time.Sleep(100 * time.Millisecond)

	if got := ws.GetClientVoiceChIDForTest(c); got != 0 {
		t.Fatalf("voiceChID after rollback = %d, want 0", got)
	}

	state, _ := database.GetVoiceState(context.Background(), user.ID)
	if state != nil {
		t.Fatal("voice state should be nil after rollback")
	}

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	foundLeave := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_leave" {
			foundLeave = true
			break
		}
	}
	if !foundLeave {
		t.Error("expected voice_leave broadcast after rollback")
	}
}

func TestRollbackVoiceJoin_NoDBState_DoesNotPanic(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "rb-nostate")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	ws.SetVoiceChIDForTest(c, 999)
	hub.RollbackVoiceJoinForTest(c, 999)
	time.Sleep(50 * time.Millisecond)

	if got := ws.GetClientVoiceChIDForTest(c); got != 0 {
		t.Fatalf("voiceChID after rollback = %d, want 0", got)
	}
}

// ─── leaveVoiceChannelWithRetry (voice_leave.go:57) ─────────────────────────

func TestLeaveVoiceChannelWithRetry_SuccessOnFirstAttempt(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "lvcr-ok")
	vcID := seedVoiceChannel(t, database, "lvcr-ok-vc")

	if err := database.JoinVoiceChannel(context.Background(), user.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	state, _ := database.GetVoiceState(context.Background(), user.ID)
	if state == nil {
		t.Fatal("voice state should exist before leave")
	}

	err := ws.LeaveVoiceChannelWithRetryForTest(hub, user.ID, vcID, state.JoinedAt)
	if err != nil {
		t.Fatalf("leaveVoiceChannelWithRetry returned error: %v", err)
	}

	state, _ = database.GetVoiceState(context.Background(), user.ID)
	if state != nil {
		t.Fatal("voice state should be nil after successful leave")
	}
}

func TestLeaveVoiceChannelWithRetry_NoVoiceState_NilReturn(t *testing.T) {
	hub, database := newCoverageHub(t)
	_ = seedCoverageOwner(t, database, "lvcr-nostate")

	err := ws.LeaveVoiceChannelWithRetryForTest(hub, 9999, 1, "")
	if err != nil {
		t.Fatalf("expected nil error for non-existent voice state, got: %v", err)
	}
}

// ─── CleanupVoiceForChannel (hub.go:237) — additional paths ─────────────────

func TestCleanupVoiceForChannel_WithClientsInChannel(t *testing.T) {
	hub, database := newCoverageHub(t)
	user1 := seedCoverageOwner(t, database, "cvfc-u1")
	user2 := seedCoverageOwner(t, database, "cvfc-u2")
	vcID := seedVoiceChannel(t, database, "cvfc-vc")

	send1 := make(chan []byte, 64)
	send2 := make(chan []byte, 64)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c1)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)

	if err := database.JoinVoiceChannel(context.Background(), user1.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel u1: %v", err)
	}
	if err := database.JoinVoiceChannel(context.Background(), user2.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel u2: %v", err)
	}
	ws.SetVoiceChIDForTest(c1, vcID)
	ws.SetVoiceChIDForTest(c2, vcID)

	hub.CleanupVoiceForChannel(vcID)
	time.Sleep(100 * time.Millisecond)

	if got := ws.GetClientVoiceChIDForTest(c1); got != 0 {
		t.Errorf("c1 voiceChID = %d, want 0", got)
	}
	if got := ws.GetClientVoiceChIDForTest(c2); got != 0 {
		t.Errorf("c2 voiceChID = %d, want 0", got)
	}

	states, _ := database.GetChannelVoiceStates(context.Background(), vcID)
	if len(states) != 0 {
		t.Errorf("expected 0 voice states after cleanup, got %d", len(states))
	}
}

func TestCleanupVoiceForChannel_EmptyChannel(t *testing.T) {
	hub, database := newCoverageHub(t)
	vcID := seedVoiceChannel(t, database, "cvfc-empty-vc")
	hub.CleanupVoiceForChannel(vcID)
	time.Sleep(20 * time.Millisecond)

	// After cleanup of an empty channel, voice states should still be empty.
	states, err := database.GetChannelVoiceStates(context.Background(), vcID)
	if err != nil {
		t.Fatalf("GetChannelVoiceStates: %v", err)
	}
	if len(states) != 0 {
		t.Errorf("expected 0 voice states after cleaning empty channel, got %d", len(states))
	}
}

func TestCleanupVoiceForChannel_DBStateButNoClient(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "cvfc-noclient")
	vcID := seedVoiceChannel(t, database, "cvfc-noclient-vc")

	if err := database.JoinVoiceChannel(context.Background(), user.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	hub.CleanupVoiceForChannel(vcID)
	time.Sleep(50 * time.Millisecond)

	state, _ := database.GetVoiceState(context.Background(), user.ID)
	if state != nil {
		t.Error("voice state should be nil after cleanup")
	}
}

// ─── sweepStaleVoiceStates (hub.go:489) ─────────────────────────────────────

func TestSweepStaleVoiceStates_RemovesGhostState(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "sweep-ghost")
	vcID := seedVoiceChannel(t, database, "sweep-ghost-vc")

	// Put user in voice in DB but don't register a client — ghost state.
	if err := database.JoinVoiceChannel(context.Background(), user.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	// Verify it exists.
	state, _ := database.GetVoiceState(context.Background(), user.ID)
	if state == nil {
		t.Fatal("voice state should exist before sweep")
	}

	hub.SweepStaleVoiceStatesForTest()
	time.Sleep(100 * time.Millisecond)

	// Ghost state should be removed.
	state, _ = database.GetVoiceState(context.Background(), user.ID)
	if state != nil {
		t.Error("ghost voice state should be nil after sweep")
	}
}

func TestSweepStaleVoiceStates_PreservesActiveClientState(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "sweep-active")
	vcID := seedVoiceChannel(t, database, "sweep-active-vc")

	// Register client and set voice channel.
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	if err := database.JoinVoiceChannel(context.Background(), user.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	ws.SetVoiceChIDForTest(c, vcID)

	hub.SweepStaleVoiceStatesForTest()
	time.Sleep(100 * time.Millisecond)

	// Active client's state should be preserved.
	state, _ := database.GetVoiceState(context.Background(), user.ID)
	if state == nil {
		t.Error("active client's voice state should be preserved after sweep")
	}
}

func TestSweepStaleVoiceStates_NoStatesNoPanic(t *testing.T) {
	hub, database := newCoverageHub(t)
	hub.SweepStaleVoiceStatesForTest()
	time.Sleep(50 * time.Millisecond)

	// With no voice states in the DB, sweep should leave the system clean.
	// Verify by checking a known user has no voice state.
	user := seedCoverageOwner(t, database, "sweep-no-states")
	state, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state != nil {
		t.Error("expected nil voice state for user after sweep with no states")
	}
}

func TestSweepStaleVoiceStates_MismatchedChannelIsGhost(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "sweep-mismatch")
	vc1 := seedVoiceChannel(t, database, "sweep-mismatch-vc1")
	vc2 := seedVoiceChannel(t, database, "sweep-mismatch-vc2")

	// Register client in vc1 but DB says vc2.
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	if err := database.JoinVoiceChannel(context.Background(), user.ID, vc2); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	ws.SetVoiceChIDForTest(c, vc1) // Client thinks vc1, DB says vc2 — mismatch.

	hub.SweepStaleVoiceStatesForTest()
	time.Sleep(100 * time.Millisecond)

	// Mismatched state should be removed from DB.
	state, _ := database.GetVoiceState(context.Background(), user.ID)
	if state != nil {
		t.Error("mismatched voice state should be removed after sweep")
	}
}

// TestSweepStaleVoiceStates_EvictsRevokedConnectVoice locks the revocation half
// of the voice-permission invariant: nothing in ws re-validated CONNECT_VOICE
// for a connection that stays open, so stripping the bit blocked future joins
// but left the offender in the room. The sweep must now evict them — DB row
// gone and the client's own voice state cleared.
func TestSweepStaleVoiceStates_EvictsRevokedConnectVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	// Member role (id 4), not Owner: admins bypass every channel check.
	if _, err := database.CreateUser(context.Background(), "sweep-revoked", "hash", 4); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername(context.Background(), "sweep-revoked")
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	vcID := seedVoiceChannel(t, database, "sweep-revoked-vc")

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	if joinErr := database.JoinVoiceChannel(context.Background(), user.ID, vcID); joinErr != nil {
		t.Fatalf("JoinVoiceChannel: %v", joinErr)
	}
	vs, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState after join: %v", err)
	}
	ws.SetClientVoiceStateForTest(c, vcID, vs.JoinedAt)

	// Still permitted → the sweep leaves them alone.
	hub.SweepStaleVoiceStatesForTest()
	time.Sleep(100 * time.Millisecond)
	if state, _ := database.GetVoiceState(context.Background(), user.ID); state == nil {
		t.Fatal("a permitted participant must survive the sweep")
	}

	// Moderator revokes CONNECT_VOICE on this channel for the Member role.
	if permErr := database.UpsertChannelOverride(
		context.Background(), vcID, 4, 0, permissions.ConnectVoice,
	); permErr != nil {
		t.Fatalf("UpsertChannelOverride: %v", permErr)
	}

	hub.SweepStaleVoiceStatesForTest()
	time.Sleep(200 * time.Millisecond)

	if state, _ := database.GetVoiceState(context.Background(), user.ID); state != nil {
		t.Error("revoked participant's voice state must be deleted by the sweep")
	}
	if chID := ws.GetClientVoiceChIDForTest(c); chID != 0 {
		t.Errorf("revoked participant's client voice state must be cleared, got channel %d", chID)
	}
}
