package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// ─── schema for channel tests ─────────────────────────────────────────────────

var channelTestSchema = []byte(`
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
    ban_expires TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    device     TEXT,
    ip_address TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

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
    voice_max_video  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channel_overrides (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles(id)    ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(channel_id, role_id)
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
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT    PRIMARY KEY,
    message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    filename    TEXT    NOT NULL,
    stored_as   TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    emoji      TEXT    NOT NULL,
    UNIQUE(message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS read_states (
    user_id         INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_message_id INTEGER NOT NULL DEFAULT 0,
    mention_count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
);
CREATE TABLE IF NOT EXISTS invites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    NOT NULL UNIQUE,
    created_by  INTEGER NOT NULL REFERENCES users(id),
    redeemed_by INTEGER REFERENCES users(id),
    max_uses    INTEGER,
    use_count   INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('server_name', 'OwnCord Server'),
    ('motd', 'Welcome!');
`)

// ─── helpers ──────────────────────────────────────────────────────────────────

func newChannelTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	migrFS := fstest.MapFS{"001_schema.sql": {Data: channelTestSchema}}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

func buildChannelRouter(database *db.DB) http.Handler {
	r := chi.NewRouter()
	api.MountChannelRoutes(r, database)
	return r
}

// chTestCreateToken creates a user+session and returns the plaintext token.
func chTestCreateToken(t *testing.T, database *db.DB, username string, roleID int) string {
	t.Helper()
	_, err := database.CreateUser(username, "$2a$12$fake", roleID)
	if err != nil {
		t.Fatalf("CreateUser %q: %v", username, err)
	}
	token := "chtest-token-" + username
	hash := auth.HashToken(token)
	_, err = database.Exec(
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at)
		 SELECT id, ?, 'test', '127.0.0.1', '2099-01-01T00:00:00Z' FROM users WHERE username = ?`,
		hash, username,
	)
	if err != nil {
		t.Fatalf("insert session for %q: %v", username, err)
	}
	return token
}

func chGet(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
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

// ─── GET /api/v1/channels ─────────────────────────────────────────────────────

func TestChannelList_Unauthenticated(t *testing.T) {
	router := buildChannelRouter(newChannelTestDB(t))
	rr := chGet(t, router, "/api/v1/channels", "")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
	}
}

func TestChannelList_Empty(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "alice", 1)

	rr := chGet(t, router, "/api/v1/channels", token)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var resp []any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if len(resp) != 0 {
		t.Errorf("expected empty array, got %d items", len(resp))
	}
}

func TestChannelList_WithChannels(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "bob", 1)

	_, _ = database.CreateChannel("general", "text", "", "", 0)
	_, _ = database.CreateChannel("random", "text", "", "", 1)

	rr := chGet(t, router, "/api/v1/channels", token)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rr.Code)
	}
	var resp []any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if len(resp) != 2 {
		t.Errorf("expected 2 channels, got %d", len(resp))
	}
}

// ─── GET /api/v1/channels/{id}/messages ──────────────────────────────────────

func TestChannelMessages_Unauthenticated(t *testing.T) {
	router := buildChannelRouter(newChannelTestDB(t))
	rr := chGet(t, router, "/api/v1/channels/1/messages", "")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
	}
}

func TestChannelMessages_InvalidID(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "carol", 1)

	rr := chGet(t, router, "/api/v1/channels/abc/messages", token)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestChannelMessages_ChannelNotFound(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "dave", 1)

	rr := chGet(t, router, "/api/v1/channels/9999/messages", token)
	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rr.Code)
	}
}

func TestChannelMessages_EmptyChannel(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "eve", 1)
	chID, _ := database.CreateChannel("general", "text", "", "", 0)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages", chID), token)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	msgs, ok := resp["messages"].([]any)
	if !ok || len(msgs) != 0 {
		t.Errorf("expected empty messages array, got: %v", resp["messages"])
	}
}

func TestChannelMessages_ReturnsMessages(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "frank", 1)
	user, _ := database.GetUserByUsername("frank")
	chID, _ := database.CreateChannel("ch", "text", "", "", 0)

	for i := range 3 {
		_, _ = database.CreateMessage(chID, user.ID, fmt.Sprintf("msg%d", i), nil)
	}

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages", chID), token)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rr.Code)
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	msgs := resp["messages"].([]any)
	if len(msgs) != 3 {
		t.Errorf("expected 3 messages, got %d", len(msgs))
	}
}

func TestChannelMessages_LimitCappedAt100(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "grace", 1)
	chID, _ := database.CreateChannel("ch", "text", "", "", 0)

	// limit=200 should succeed (capped internally).
	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?limit=200", chID), token)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rr.Code)
	}
}

func TestChannelMessages_HasMore(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "henry", 1)
	user, _ := database.GetUserByUsername("henry")
	chID, _ := database.CreateChannel("ch", "text", "", "", 0)

	for i := range 60 {
		_, _ = database.CreateMessage(chID, user.ID, fmt.Sprintf("m%d", i), nil)
	}

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?limit=50", chID), token)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rr.Code)
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["has_more"] != true {
		t.Errorf("has_more = %v, want true", resp["has_more"])
	}
}

func TestChannelMessages_HasMoreFalse(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "ivan", 1)
	user, _ := database.GetUserByUsername("ivan")
	chID, _ := database.CreateChannel("ch", "text", "", "", 0)

	for i := range 5 {
		_, _ = database.CreateMessage(chID, user.ID, fmt.Sprintf("m%d", i), nil)
	}

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?limit=50", chID), token)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rr.Code)
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["has_more"] != false {
		t.Errorf("has_more = %v, want false", resp["has_more"])
	}
}

// ─── GET /api/v1/search ───────────────────────────────────────────────────────

func TestSearch_Unauthenticated(t *testing.T) {
	router := buildChannelRouter(newChannelTestDB(t))
	rr := chGet(t, router, "/api/v1/search?q=hello", "")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
	}
}

func TestSearch_MissingQuery(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "julia", 1)

	rr := chGet(t, router, "/api/v1/search", token)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestSearch_ReturnsResults(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "kim", 1)
	user, _ := database.GetUserByUsername("kim")
	chID, _ := database.CreateChannel("searchable", "text", "", "", 0)
	_, _ = database.CreateMessage(chID, user.ID, "uniqueterm in message", nil)

	rr := chGet(t, router, "/api/v1/search?q=uniqueterm", token)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	results, ok := resp["results"].([]any)
	if !ok || len(results) == 0 {
		t.Errorf("expected search results, got: %v", resp)
	}
}

func TestSearch_NoResults(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "larry", 1)

	rr := chGet(t, router, "/api/v1/search?q=xyzzynotfound", token)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rr.Code)
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	results := resp["results"].([]any)
	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}
}
