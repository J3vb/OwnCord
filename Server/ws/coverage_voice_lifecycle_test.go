package ws_test

// coverage_voice_lifecycle_test.go: voice token refresh, rollback, leave
// retry, cleanup, and stale-state sweep coverage tests (split from
// coverage_boost_test.go).

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── voice_token_refresh (now V2 — dispatched via handleMessage) ────────────

func TestHandleVoiceTokenRefresh_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vtr-notinvoice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceTokenRefreshMsg())

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": vcID},
	})
	hub.HandleMessageForTest(c, raw)
	drainChanTimeout(send, 100*time.Millisecond)

	hub.HandleMessageForTest(c, voiceTokenRefreshMsg())

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
	// covers — but the user row and the channel row must exist so the join
	// gate the refresh re-runs (permissions.CanJoinVoice) can resolve a role
	// and a channel. Without them the handler stops at FORBIDDEN and never
	// reaches the missing-voice-state branch under test.
	user := seedCoverageOwner(t, database, "vtr-nil-user")
	chID := seedVoiceChannel(t, database, "vtr-nil-user-chan")
	send := make(chan []byte, 16)
	c := ws.NewTestClient(hub, user.ID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	ws.SetVoiceChIDForTest(c, chID)

	hub.HandleMessageForTest(c, voiceTokenRefreshMsg())

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "INTERNAL" {
		t.Errorf("error code = %q, want INTERNAL", code)
	}
}

// ─── rollbackVoiceJoin (voice_join.go) ──────────────────────────────────

func TestRollbackVoiceJoin_ClearsVoiceStateAndBroadcasts(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "rb-user")
	vcID := seedVoiceChannel(t, database, "rb-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	if err := database.JoinVoiceChannel(context.Background(), user.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	ws.SetVoiceChIDForTest(c, vcID)

	// rollbackVoiceJoin, CleanupVoiceForChannel, and sweepStaleVoiceStates are
	// synchronous — their client/DB effects are visible as soon as they return.
	hub.RollbackVoiceJoinForTest(c, vcID)

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
	waitRegistered(t, hub, c)

	ws.SetVoiceChIDForTest(c, 999)
	hub.RollbackVoiceJoinForTest(c, 999)

	if got := ws.GetClientVoiceChIDForTest(c); got != 0 {
		t.Fatalf("voiceChID after rollback = %d, want 0", got)
	}
}

// OC-0044: rollbackVoiceJoin must not let a stale/failed join's compensating
// delete destroy a newer voice_states row a second connection for the same
// user has since legitimately established. A delayed rollback (the dying
// connection that triggered it is the most common case) firing
// "DELETE ... WHERE user_id = ?" with no channel/token condition wipes
// whatever the user is currently in, not just the failed join.
//
// This covers the token-generation-failure call site (voiceJoinGrantToken),
// which already holds the failed join's own JoinedAt by the time it rolls
// back — that value must scope the delete instead of being discarded.
func TestRollbackVoiceJoin_StaleTokenDoesNotDeleteNewerJoin(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "rb-stale-token")
	staleChID := seedVoiceChannel(t, database, "rb-stale-token-old")
	newChID := seedVoiceChannel(t, database, "rb-stale-token-new")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// A second connection for the same user has already joined a different
	// channel and committed its own voice_states row by the time the stale
	// rollback below runs.
	if err := database.JoinVoiceChannel(context.Background(), user.ID, newChID); err != nil {
		t.Fatalf("JoinVoiceChannel (newer): %v", err)
	}
	newState, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil || newState == nil {
		t.Fatalf("GetVoiceState (newer): state=%v err=%v", newState, err)
	}

	// Roll back the stale, now-superseded join to staleChID using a join
	// token that does not match the row currently in the DB (newChID's).
	hub.RollbackVoiceJoinWithTokenForTest(c, staleChID, "stale-token-does-not-match-anything")

	got, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState after rollback: %v", err)
	}
	if got == nil {
		t.Fatal("rollbackVoiceJoin deleted the newer voice membership it did not own")
	}
	if got.ChannelID != newChID || got.JoinedAt != newState.JoinedAt {
		t.Fatalf("voice state after rollback = %+v, want unchanged channel=%d joined_at=%q",
			got, newChID, newState.JoinedAt)
	}
}

// OC-0044: mirrors the GetVoiceState-failure call site (voiceJoinPersist),
// which never learns the failed join's own JoinedAt and so rolls back with
// an empty token. That must not degrade to the old unconditional
// "DELETE ... WHERE user_id = ?" — it must re-read the row and refuse to
// touch it unless the row still names the channel being rolled back.
func TestRollbackVoiceJoin_EmptyTokenDoesNotDeleteDifferentChannel(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "rb-empty-token")
	staleChID := seedVoiceChannel(t, database, "rb-empty-token-old")
	newChID := seedVoiceChannel(t, database, "rb-empty-token-new")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	if err := database.JoinVoiceChannel(context.Background(), user.ID, newChID); err != nil {
		t.Fatalf("JoinVoiceChannel (newer): %v", err)
	}
	newState, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil || newState == nil {
		t.Fatalf("GetVoiceState (newer): state=%v err=%v", newState, err)
	}

	// RollbackVoiceJoinForTest exercises the empty-joinedAt path.
	hub.RollbackVoiceJoinForTest(c, staleChID)

	got, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState after rollback: %v", err)
	}
	if got == nil {
		t.Fatal("rollbackVoiceJoin deleted the newer voice membership it did not own")
	}
	if got.ChannelID != newChID || got.JoinedAt != newState.JoinedAt {
		t.Fatalf("voice state after rollback = %+v, want unchanged channel=%d joined_at=%q",
			got, newChID, newState.JoinedAt)
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
	waitRegistered(t, hub, c2)

	if err := database.JoinVoiceChannel(context.Background(), user1.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel u1: %v", err)
	}
	if err := database.JoinVoiceChannel(context.Background(), user2.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel u2: %v", err)
	}
	ws.SetVoiceChIDForTest(c1, vcID)
	ws.SetVoiceChIDForTest(c2, vcID)
	hub.SubscribeVoiceTopicForTest(c1, vcID) // as the real voice_join flow does
	hub.SubscribeVoiceTopicForTest(c2, vcID)

	hub.CleanupVoiceForChannel(vcID)

	if got := ws.GetClientVoiceChIDForTest(c1); got != 0 {
		t.Errorf("c1 voiceChID = %d, want 0", got)
	}
	if got := ws.GetClientVoiceChIDForTest(c2); got != 0 {
		t.Errorf("c2 voiceChID = %d, want 0", got)
	}
	// Channel deletion must also drop the voice-topic subscriptions, or the
	// clients keep receiving stale voice_e2ee_announce relays for the dead room.
	if hub.SubscribedToVoiceTopicForTest(c1, vcID) {
		t.Error("c1 still subscribed to the deleted channel's voice topic")
	}
	if hub.SubscribedToVoiceTopicForTest(c2, vcID) {
		t.Error("c2 still subscribed to the deleted channel's voice topic")
	}

	states, _ := database.GetChannelVoiceStates(context.Background(), vcID)
	if len(states) != 0 {
		t.Errorf("expected 0 voice states after cleanup, got %d", len(states))
	}
}

// A user who moved to another voice channel between the cleanup's DB snapshot
// and its per-participant loop must not be clobbered: the deleted channel's
// stale row goes away, but the live client state and the new channel's
// voice-topic subscription are untouched.
func TestCleanupVoiceForChannel_DoesNotClobberMovedParticipant(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "cvfc-moved")
	oldVC := seedVoiceChannel(t, database, "cvfc-moved-old")
	newVC := seedVoiceChannel(t, database, "cvfc-moved-new")

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// DB row still on the old channel (the snapshot the cleanup reads), but
	// the client has already moved on to the new channel.
	if err := database.JoinVoiceChannel(context.Background(), user.ID, oldVC); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	ws.SetVoiceChIDForTest(c, newVC)
	hub.SubscribeVoiceTopicForTest(c, newVC)

	hub.CleanupVoiceForChannel(oldVC)

	if got := ws.GetClientVoiceChIDForTest(c); got != newVC {
		t.Errorf("moved participant's client voiceChID = %d, want %d", got, newVC)
	}
	if !hub.SubscribedToVoiceTopicForTest(c, newVC) {
		t.Error("moved participant lost the new channel's voice-topic subscription")
	}
}

func TestCleanupVoiceForChannel_EmptyChannel(t *testing.T) {
	hub, database := newCoverageHub(t)
	vcID := seedVoiceChannel(t, database, "cvfc-empty-vc")
	hub.CleanupVoiceForChannel(vcID)

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
	waitRegistered(t, hub, c)

	if err := database.JoinVoiceChannel(context.Background(), user.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	ws.SetVoiceChIDForTest(c, vcID)

	hub.SweepStaleVoiceStatesForTest()

	// Active client's state should be preserved.
	state, _ := database.GetVoiceState(context.Background(), user.ID)
	if state == nil {
		t.Error("active client's voice state should be preserved after sweep")
	}
}

func TestSweepStaleVoiceStates_NoStatesNoPanic(t *testing.T) {
	hub, database := newCoverageHub(t)
	hub.SweepStaleVoiceStatesForTest()

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
	waitRegistered(t, hub, c)

	if err := database.JoinVoiceChannel(context.Background(), user.ID, vc2); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	ws.SetVoiceChIDForTest(c, vc1) // Client thinks vc1, DB says vc2 — mismatch.

	hub.SweepStaleVoiceStatesForTest()

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
	waitRegistered(t, hub, c)

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

	if state, _ := database.GetVoiceState(context.Background(), user.ID); state != nil {
		t.Error("revoked participant's voice state must be deleted by the sweep")
	}
	if chID := ws.GetClientVoiceChIDForTest(c); chID != 0 {
		t.Errorf("revoked participant's client voice state must be cleared, got channel %d", chID)
	}
}
