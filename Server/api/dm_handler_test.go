package api_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// ─── DM test schema ─────────────────────────────────────────────────────────

// dmTestSchema includes roles, users, sessions, channels, messages, and DM
// tables needed by DM handler tests.
var dmTestSchema = []byte(schemaAccounts + schemaMessaging + schemaPolls + `
-- AuthMiddleware falls through to an API-token lookup whenever a bearer
-- token matches no session (auth.ResolveTokenHash), so this table must exist
-- even in DM-only fixtures — otherwise an ordinary "no such session" lookup
-- for a garbage/unknown token hits GetActiveAPIToken and fails with a real
-- "no such table" SQL error instead of the intended not-found sentinel.
CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT    NOT NULL UNIQUE,
    label        TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    expires_at   TEXT,
    revoked_at   TEXT
);
CREATE TABLE IF NOT EXISTS channels (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    type             TEXT    NOT NULL DEFAULT 'text',
    category_id INTEGER REFERENCES channel_categories(id) ON DELETE SET NULL,
    permissions_synced INTEGER NOT NULL DEFAULT 0,
    topic            TEXT,
    position         INTEGER NOT NULL DEFAULT 0,
    slow_mode        INTEGER NOT NULL DEFAULT 0,
    archived         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    voice_max_users  INTEGER NOT NULL DEFAULT 0,
    voice_quality    TEXT,
    mixing_threshold INTEGER,
    voice_max_video  INTEGER NOT NULL DEFAULT 0,
    nsfw             INTEGER NOT NULL DEFAULT 0,
    afk             INTEGER NOT NULL DEFAULT 0,
    parent_channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
    thread_starter_message_id INTEGER,
    thread_owner_id INTEGER,
    thread_archived INTEGER NOT NULL DEFAULT 0,
    thread_locked INTEGER NOT NULL DEFAULT 0,
    thread_auto_archive_minutes INTEGER NOT NULL DEFAULT 1440,
    thread_last_activity_at TEXT,
    forum_require_tag INTEGER NOT NULL DEFAULT 0,
    forum_default_auto_archive_minutes INTEGER NOT NULL DEFAULT 4320,
    import_pending INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    password_version INTEGER NOT NULL DEFAULT 0,
    is_group         INTEGER NOT NULL DEFAULT 0,
    dm_owner_id      INTEGER,
    dm_icon      TEXT
);
CREATE TABLE IF NOT EXISTS message_group_events (
    message_id     INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT,
    icon_removed   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id != blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_message_requests_recipient_state
    ON message_requests(recipient_id, state);
`)

// ─── helpers ────────────────────────────────────────────────────────────────

func newDMTestDB(t *testing.T) *db.DB {
	t.Helper()
	return openSchemaDB(t, dmTestSchema)
}

// mockBroadcaster implements api.DMBroadcaster for tests.
type mockBroadcaster struct {
	sent []mockBroadcastMsg
}

type mockBroadcastMsg struct {
	UserID int64
	Msg    []byte
}

func (m *mockBroadcaster) SendToUser(userID int64, msg []byte) bool {
	m.sent = append(m.sent, mockBroadcastMsg{UserID: userID, Msg: msg})
	return true
}

// dmCreateToken creates a user+session and returns the plaintext token.
func dmCreateToken(t *testing.T, database *db.DB, username string, roleID int) string {
	t.Helper()
	return createUserToken(t, database, "dmtest-token-", username, roleID)
}

func buildDMRouter(database *db.DB, broadcaster api.DMBroadcaster) http.Handler {
	r := chi.NewRouter()
	svc := service.New(database, auth.NewRateLimiter())
	api.MountDMRoutes(r, svc, broadcaster, nil, nil)
	return r
}

func dmPost(t *testing.T, router http.Handler, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	return doAPIJSON(t, router, http.MethodPost, path, token, body)
}

func dmGet(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	return doAPI(t, router, http.MethodGet, path, token, nil)
}

func dmDelete(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	return doAPI(t, router, http.MethodDelete, path, token, nil)
}

// ─── POST /api/v1/dms (handleCreateDM) ─────────────────────────────────────

func TestCreateDM_Success_NewDM(t *testing.T) {
	database := newDMTestDB(t)
	broadcaster := &mockBroadcaster{}
	router := buildDMRouter(database, broadcaster)

	tokenAlice := dmCreateToken(t, database, "alice", 4)
	_ = dmCreateToken(t, database, "bob", 4)
	bob, _ := database.GetUserByUsername(context.Background(), "bob")

	rr := dmPost(t, router, "/api/v1/dms", tokenAlice, map[string]any{
		"recipient_id": bob.ID,
	})

	expectStatus(t, rr, http.StatusCreated)

	resp := decodeBody[map[string]any](t, rr)
	if resp["created"] != true {
		t.Errorf("CreateDM new: created = %v, want true", resp["created"])
	}
	if resp["channel_id"] == nil {
		t.Error("CreateDM new: missing channel_id")
	}
	recipient, ok := resp["recipient"].(map[string]any)
	if !ok || recipient["username"] != "bob" {
		t.Errorf("CreateDM new: recipient = %v, want bob", resp["recipient"])
	}
}

func TestCreateDM_Success_ExistingDM(t *testing.T) {
	database := newDMTestDB(t)
	broadcaster := &mockBroadcaster{}
	router := buildDMRouter(database, broadcaster)

	tokenAlice := dmCreateToken(t, database, "alice2", 4)
	_ = dmCreateToken(t, database, "bob2", 4)
	bob, _ := database.GetUserByUsername(context.Background(), "bob2")

	// First call creates the DM.
	rr1 := dmPost(t, router, "/api/v1/dms", tokenAlice, map[string]any{
		"recipient_id": bob.ID,
	})
	requireStatus(t, rr1, http.StatusCreated)

	// Second call returns the existing one.
	rr2 := dmPost(t, router, "/api/v1/dms", tokenAlice, map[string]any{
		"recipient_id": bob.ID,
	})
	expectStatus(t, rr2, http.StatusOK)

	resp := decodeBody[map[string]any](t, rr2)
	if resp["created"] != false {
		t.Errorf("existing CreateDM: created = %v, want false", resp["created"])
	}
}

func TestCreateDM_BadRequest_EmptyBody(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)
	token := dmCreateToken(t, database, "empty_body_user", 4)

	rr := doAPIRawJSON(t, router, http.MethodPost, "/api/v1/dms", token, "")

	expectStatus(t, rr, http.StatusBadRequest)
}

func TestCreateDM_BadRequest_NegativeRecipientID(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)
	token := dmCreateToken(t, database, "neg_user", 4)

	rr := dmPost(t, router, "/api/v1/dms", token, map[string]any{
		"recipient_id": -1,
	})
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestCreateDM_BadRequest_ZeroRecipientID(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)
	token := dmCreateToken(t, database, "zero_user", 4)

	rr := dmPost(t, router, "/api/v1/dms", token, map[string]any{
		"recipient_id": 0,
	})
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestCreateDM_BadRequest_SelfDM(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)
	token := dmCreateToken(t, database, "selfuser", 4)
	self, _ := database.GetUserByUsername(context.Background(), "selfuser")

	rr := dmPost(t, router, "/api/v1/dms", token, map[string]any{
		"recipient_id": self.ID,
	})
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestCreateDM_NotFound_RecipientMissing(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)
	token := dmCreateToken(t, database, "lonely_user", 4)

	rr := dmPost(t, router, "/api/v1/dms", token, map[string]any{
		"recipient_id": 99999,
	})
	expectStatus(t, rr, http.StatusNotFound)
}

func TestCreateDM_Unauthorized(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)

	rr := dmPost(t, router, "/api/v1/dms", "", map[string]any{
		"recipient_id": 1,
	})
	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── GET /api/v1/dms (handleListDMs) ────────────────────────────────────────

func TestListDMs_ReturnsOpenDMs(t *testing.T) {
	database := newDMTestDB(t)
	broadcaster := &mockBroadcaster{}
	router := buildDMRouter(database, broadcaster)

	tokenAlice := dmCreateToken(t, database, "list_alice", 4)
	_ = dmCreateToken(t, database, "list_bob", 4)
	bob, _ := database.GetUserByUsername(context.Background(), "list_bob")

	// Create a DM.
	rr1 := dmPost(t, router, "/api/v1/dms", tokenAlice, map[string]any{
		"recipient_id": bob.ID,
	})
	requireStatus(t, rr1, http.StatusCreated)

	// List DMs.
	rr := dmGet(t, router, "/api/v1/dms", tokenAlice)
	expectStatus(t, rr, http.StatusOK)

	resp := decodeBody[map[string]any](t, rr)
	channels, ok := resp["dm_channels"].([]any)
	if !ok {
		t.Fatalf("ListDMs: dm_channels not an array: %v", resp)
	}
	if len(channels) != 1 {
		t.Errorf("ListDMs: got %d channels, want 1", len(channels))
	}
}

func TestListDMs_EmptyArray(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)
	token := dmCreateToken(t, database, "no_dms_user", 4)

	rr := dmGet(t, router, "/api/v1/dms", token)
	expectStatus(t, rr, http.StatusOK)

	resp := decodeBody[map[string]any](t, rr)
	channels, ok := resp["dm_channels"].([]any)
	if !ok || len(channels) != 0 {
		t.Errorf("ListDMs empty: expected empty array, got %v", resp["dm_channels"])
	}
}

func TestListDMs_Unauthorized(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)

	rr := dmGet(t, router, "/api/v1/dms", "")
	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── DELETE /api/v1/dms/{channelId} (handleCloseDM) ────────────────────────

func TestCloseDM_Success(t *testing.T) {
	database := newDMTestDB(t)
	broadcaster := &mockBroadcaster{}
	router := buildDMRouter(database, broadcaster)

	tokenAlice := dmCreateToken(t, database, "close_alice", 4)
	_ = dmCreateToken(t, database, "close_bob", 4)
	bob, _ := database.GetUserByUsername(context.Background(), "close_bob")

	// Create a DM.
	rr1 := dmPost(t, router, "/api/v1/dms", tokenAlice, map[string]any{
		"recipient_id": bob.ID,
	})
	requireStatus(t, rr1, http.StatusCreated)
	createResp := decodeBody[map[string]any](t, rr1)
	channelID := createResp["channel_id"]

	// Close the DM.
	rr := dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%v", channelID), tokenAlice)
	expectStatus(t, rr, http.StatusNoContent)

	// Verify broadcaster was notified.
	if len(broadcaster.sent) == 0 {
		t.Error("CloseDM: expected broadcaster SendToUser call")
	}
}

func TestCloseDM_Success_VerifyRemovedFromList(t *testing.T) {
	database := newDMTestDB(t)
	broadcaster := &mockBroadcaster{}
	router := buildDMRouter(database, broadcaster)

	tokenAlice := dmCreateToken(t, database, "closelist_alice", 4)
	_ = dmCreateToken(t, database, "closelist_bob", 4)
	bob, _ := database.GetUserByUsername(context.Background(), "closelist_bob")

	// Create a DM.
	rr1 := dmPost(t, router, "/api/v1/dms", tokenAlice, map[string]any{
		"recipient_id": bob.ID,
	})
	requireStatus(t, rr1, http.StatusCreated)
	createResp := decodeBody[map[string]any](t, rr1)
	channelID := createResp["channel_id"]

	// Close the DM.
	dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%v", channelID), tokenAlice)

	// List should be empty for alice now.
	rr := dmGet(t, router, "/api/v1/dms", tokenAlice)
	listResp := decodeBody[map[string]any](t, rr)
	channels := listResp["dm_channels"].([]any)
	if len(channels) != 0 {
		t.Errorf("CloseDM verify: expected 0 DMs after close, got %d", len(channels))
	}
}

func TestCloseDM_Forbidden_NotParticipant(t *testing.T) {
	database := newDMTestDB(t)
	broadcaster := &mockBroadcaster{}
	router := buildDMRouter(database, broadcaster)

	tokenAlice := dmCreateToken(t, database, "forbid_alice", 4)
	_ = dmCreateToken(t, database, "forbid_bob", 4)
	tokenCharlie := dmCreateToken(t, database, "forbid_charlie", 4)
	bob, _ := database.GetUserByUsername(context.Background(), "forbid_bob")

	// Alice creates DM with Bob.
	rr1 := dmPost(t, router, "/api/v1/dms", tokenAlice, map[string]any{
		"recipient_id": bob.ID,
	})
	requireStatus(t, rr1, http.StatusCreated)
	createResp := decodeBody[map[string]any](t, rr1)
	channelID := createResp["channel_id"]

	// Charlie (not a participant) tries to close it.
	rr := dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%v", channelID), tokenCharlie)
	expectStatus(t, rr, http.StatusNotFound)
}

func TestCloseDM_BadRequest_InvalidChannelID(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)
	token := dmCreateToken(t, database, "badid_user", 4)

	rr := dmDelete(t, router, "/api/v1/dms/abc", token)
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestCloseDM_Unauthorized(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)

	rr := dmDelete(t, router, "/api/v1/dms/1", "")
	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestCloseDM_NilBroadcaster(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil) // nil broadcaster

	token := dmCreateToken(t, database, "nilbc_alice", 4)
	_ = dmCreateToken(t, database, "nilbc_bob", 4)
	bob, _ := database.GetUserByUsername(context.Background(), "nilbc_bob")

	// Create a DM.
	rr1 := dmPost(t, router, "/api/v1/dms", token, map[string]any{
		"recipient_id": bob.ID,
	})
	requireStatus(t, rr1, http.StatusCreated)
	createResp := decodeBody[map[string]any](t, rr1)
	channelID := createResp["channel_id"]

	// Close should still succeed even with nil broadcaster.
	rr := dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%v", channelID), token)
	expectStatus(t, rr, http.StatusNoContent)
}
