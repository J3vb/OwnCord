package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// ─── DM test schema ─────────────────────────────────────────────────────────

// dmTestSchema includes roles, users, sessions, channels, messages, and DM
// tables needed by DM handler tests.
var dmTestSchema = []byte(`
CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    color       TEXT,
    permissions INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    is_default  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO roles (id, name, color, permissions, position, is_default) VALUES
    (1, 'Owner',     '#E74C3C', 2147483647, 100, 0),
    (2, 'Admin',     '#F39C12', 1073741823,  80, 0),
    (3, 'Moderator', '#3498DB', 1048575,     60, 0),
    (4, 'Member',    NULL,      1635,     40, 1);

CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password    TEXT    NOT NULL,
    avatar      TEXT,
    role_id     INTEGER NOT NULL DEFAULT 4 REFERENCES roles(id),
    totp_secret TEXT,
    status      TEXT    NOT NULL DEFAULT 'offline',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT,
    banned      INTEGER NOT NULL DEFAULT 0,
    ban_reason  TEXT,
    ban_expires TEXT,
    registration_status TEXT NOT NULL DEFAULT 'active',
    identity_public_key TEXT,
    display_name TEXT,
    about TEXT,
    custom_status TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    device     TEXT,
    ip_address TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL,
    unseen     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS recovery_kits (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    verifier   TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    used_at    TEXT
);
CREATE TABLE IF NOT EXISTS recovery_assists (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    verifier TEXT NOT NULL,
    issued_by INTEGER NOT NULL,
    verification TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

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
    category         TEXT,
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
    is_group         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    content    TEXT    NOT NULL,
    reply_to   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    edited_at  TEXT,
    deleted    INTEGER NOT NULL DEFAULT 0,
    pinned     INTEGER NOT NULL DEFAULT 0,
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now')),
    mentions_everyone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS message_mentions (
    message_id        INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    mentioned_user_id INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    PRIMARY KEY (message_id, mentioned_user_id)
);

-- Needed by GetMessages' permission resolution and reaction enrichment, even
-- for a DM-only test: channelSubject/PermissionService reads channel_overrides
-- unconditionally, and scanAndEnrichMessages always joins reactions.
CREATE TABLE IF NOT EXISTS channel_overrides (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles(id)    ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(channel_id, role_id)
);
CREATE TABLE IF NOT EXISTS channel_user_overrides (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS reactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    emoji      TEXT    NOT NULL,
    UNIQUE(message_id, user_id, emoji)
);

-- Mirrors migrations/001. Required, not optional decoration: the DM close
-- path (db.LeaveGroupDM) unlinks a channel's attachments before hard-deleting
-- the channel row, because messages.channel_id and attachments.message_id both
-- cascade ON DELETE and the cascade would otherwise destroy the rows the
-- orphan sweep needs to reclaim the files. Without this table the handler
-- answers 500.
CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT    PRIMARY KEY,
    message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    filename    TEXT    NOT NULL,
    stored_as   TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_at TEXT    NOT NULL DEFAULT (datetime('now')),
    width       INTEGER,
    height      INTEGER
);


CREATE TABLE IF NOT EXISTS dm_participants (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS dm_open_state (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    opened_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS read_states (
    user_id         INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_message_id INTEGER NOT NULL DEFAULT 0,
    mention_count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id != blocked_id)
);

-- Message requests and trusted senders (migration 046, B5-6): required by
-- every DM send through MessageService now that first contact is gated, not
-- just by dm_request_handler_test.go.
CREATE TABLE IF NOT EXISTS trusted_senders (
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source       TEXT    NOT NULL CHECK (source IN ('accepted', 'sent_first', 'grandfathered')),
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (recipient_id, sender_id)
);

CREATE TABLE IF NOT EXISTS message_requests (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    first_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    state            TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'accepted', 'ignored', 'deleted', 'blocked')),
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    decided_at       TEXT,
    UNIQUE (sender_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_message_requests_recipient_state
    ON message_requests(recipient_id, state);

-- Moderation actions (migration 049, B5-9): permissions.Checker.Subject
-- resolves TimedOut from this table for every CanSendMessage check, so it
-- is required by every DM send through MessageService too, not just
-- moderation's own tests.
CREATE TABLE IF NOT EXISTS moderation_actions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT    NOT NULL CHECK (kind IN ('warning', 'timeout', 'removal', 'kick', 'ban')),
    target_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id        INTEGER NOT NULL DEFAULT 0,
    actor_token     TEXT,
    report_id       INTEGER,
    reason          TEXT    NOT NULL DEFAULT '',
    expires_at      TEXT,
    acknowledged_at TEXT,
    lifted_at       TEXT,
    lifted_by       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
`)

// ─── helpers ────────────────────────────────────────────────────────────────

func newDMTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	migrFS := fstest.MapFS{"001_schema.sql": {Data: dmTestSchema}}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
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
	_, err := database.CreateUser(context.Background(), username, "$2a$12$fake", roleID)
	if err != nil {
		t.Fatalf("CreateUser %q: %v", username, err)
	}
	token := "dmtest-token-" + username
	hash := auth.HashToken(token)
	_, err = database.ExecContext(context.Background(),
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at)
		 SELECT id, ?, 'test', '127.0.0.1', '2099-01-01T00:00:00Z' FROM users WHERE username = ?`,
		hash, username,
	)
	if err != nil {
		t.Fatalf("insert session for %q: %v", username, err)
	}
	return token
}

func buildDMRouter(database *db.DB, broadcaster api.DMBroadcaster) http.Handler {
	r := chi.NewRouter()
	svc := service.New(database, auth.NewRateLimiter())
	api.MountDMRoutes(r, database, svc, broadcaster)
	return r
}

func dmPost(t *testing.T, router http.Handler, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func dmGet(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func dmDelete(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
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

	if rr.Code != http.StatusCreated {
		t.Errorf("CreateDM new: status = %d, want 201; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
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
	if rr1.Code != http.StatusCreated {
		t.Fatalf("first CreateDM: status = %d, want 201", rr1.Code)
	}

	// Second call returns the existing one.
	rr2 := dmPost(t, router, "/api/v1/dms", tokenAlice, map[string]any{
		"recipient_id": bob.ID,
	})
	if rr2.Code != http.StatusOK {
		t.Errorf("existing CreateDM: status = %d, want 200; body = %s", rr2.Code, rr2.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(rr2.Body).Decode(&resp)
	if resp["created"] != false {
		t.Errorf("existing CreateDM: created = %v, want false", resp["created"])
	}
}

func TestCreateDM_BadRequest_EmptyBody(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)
	token := dmCreateToken(t, database, "empty_body_user", 4)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/dms", bytes.NewReader([]byte("")))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("empty body: status = %d, want 400", rr.Code)
	}
}

func TestCreateDM_BadRequest_NegativeRecipientID(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)
	token := dmCreateToken(t, database, "neg_user", 4)

	rr := dmPost(t, router, "/api/v1/dms", token, map[string]any{
		"recipient_id": -1,
	})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("negative recipient_id: status = %d, want 400", rr.Code)
	}
}

func TestCreateDM_BadRequest_ZeroRecipientID(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)
	token := dmCreateToken(t, database, "zero_user", 4)

	rr := dmPost(t, router, "/api/v1/dms", token, map[string]any{
		"recipient_id": 0,
	})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("zero recipient_id: status = %d, want 400", rr.Code)
	}
}

func TestCreateDM_BadRequest_SelfDM(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)
	token := dmCreateToken(t, database, "selfuser", 4)
	self, _ := database.GetUserByUsername(context.Background(), "selfuser")

	rr := dmPost(t, router, "/api/v1/dms", token, map[string]any{
		"recipient_id": self.ID,
	})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("self DM: status = %d, want 400; body = %s", rr.Code, rr.Body.String())
	}
}

func TestCreateDM_NotFound_RecipientMissing(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)
	token := dmCreateToken(t, database, "lonely_user", 4)

	rr := dmPost(t, router, "/api/v1/dms", token, map[string]any{
		"recipient_id": 99999,
	})
	if rr.Code != http.StatusNotFound {
		t.Errorf("missing recipient: status = %d, want 404", rr.Code)
	}
}

func TestCreateDM_Unauthorized(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)

	rr := dmPost(t, router, "/api/v1/dms", "", map[string]any{
		"recipient_id": 1,
	})
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("no auth: status = %d, want 401", rr.Code)
	}
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
	if rr1.Code != http.StatusCreated {
		t.Fatalf("setup CreateDM: status = %d", rr1.Code)
	}

	// List DMs.
	rr := dmGet(t, router, "/api/v1/dms", tokenAlice)
	if rr.Code != http.StatusOK {
		t.Errorf("ListDMs: status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
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
	if rr.Code != http.StatusOK {
		t.Errorf("ListDMs empty: status = %d, want 200", rr.Code)
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	channels, ok := resp["dm_channels"].([]any)
	if !ok || len(channels) != 0 {
		t.Errorf("ListDMs empty: expected empty array, got %v", resp["dm_channels"])
	}
}

func TestListDMs_Unauthorized(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)

	rr := dmGet(t, router, "/api/v1/dms", "")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("ListDMs no auth: status = %d, want 401", rr.Code)
	}
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
	if rr1.Code != http.StatusCreated {
		t.Fatalf("setup CreateDM: status = %d", rr1.Code)
	}
	var createResp map[string]any
	_ = json.NewDecoder(rr1.Body).Decode(&createResp)
	channelID := createResp["channel_id"]

	// Close the DM.
	rr := dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%v", channelID), tokenAlice)
	if rr.Code != http.StatusNoContent {
		t.Errorf("CloseDM: status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}

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
	if rr1.Code != http.StatusCreated {
		t.Fatalf("setup CreateDM: status = %d", rr1.Code)
	}
	var createResp map[string]any
	_ = json.NewDecoder(rr1.Body).Decode(&createResp)
	channelID := createResp["channel_id"]

	// Close the DM.
	dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%v", channelID), tokenAlice)

	// List should be empty for alice now.
	rr := dmGet(t, router, "/api/v1/dms", tokenAlice)
	var listResp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&listResp)
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
	if rr1.Code != http.StatusCreated {
		t.Fatalf("setup CreateDM: status = %d", rr1.Code)
	}
	var createResp map[string]any
	_ = json.NewDecoder(rr1.Body).Decode(&createResp)
	channelID := createResp["channel_id"]

	// Charlie (not a participant) tries to close it.
	rr := dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%v", channelID), tokenCharlie)
	if rr.Code != http.StatusNotFound {
		t.Errorf("CloseDM not-found: status = %d, want 404; body = %s", rr.Code, rr.Body.String())
	}
}

func TestCloseDM_BadRequest_InvalidChannelID(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)
	token := dmCreateToken(t, database, "badid_user", 4)

	rr := dmDelete(t, router, "/api/v1/dms/abc", token)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("CloseDM bad ID: status = %d, want 400", rr.Code)
	}
}

func TestCloseDM_Unauthorized(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)

	rr := dmDelete(t, router, "/api/v1/dms/1", "")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("CloseDM no auth: status = %d, want 401", rr.Code)
	}
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
	if rr1.Code != http.StatusCreated {
		t.Fatalf("setup: status = %d", rr1.Code)
	}
	var createResp map[string]any
	_ = json.NewDecoder(rr1.Body).Decode(&createResp)
	channelID := createResp["channel_id"]

	// Close should still succeed even with nil broadcaster.
	rr := dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%v", channelID), token)
	if rr.Code != http.StatusNoContent {
		t.Errorf("CloseDM nil broadcaster: status = %d, want 204", rr.Code)
	}
}
