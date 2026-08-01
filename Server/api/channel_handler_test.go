package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
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
    ban_expires TEXT,
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
    voice_max_video  INTEGER NOT NULL DEFAULT 0,
    nsfw             INTEGER NOT NULL DEFAULT 0,
    is_group         INTEGER NOT NULL DEFAULT 0
);
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
    uploaded_at TEXT    NOT NULL DEFAULT (datetime('now')),
    width       INTEGER,
    height      INTEGER
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

CREATE TABLE IF NOT EXISTS dm_participants (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_dm_participants_user ON dm_participants(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER NOT NULL DEFAULT 0,
    action      TEXT    NOT NULL,
    target_type TEXT    NOT NULL DEFAULT '',
    target_id   INTEGER NOT NULL DEFAULT 0,
    detail      TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dm_open_state (
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    opened_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, channel_id)
);
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
	limiter := auth.NewRateLimiter()
	st := database
	svc := service.New(st, limiter)
	api.MountChannelRoutes(r, database, svc, limiter, nil, nil)
	return r
}

// chTestCreateToken creates a user+session and returns the plaintext token.
func chTestCreateToken(t *testing.T, database *db.DB, username string, roleID int) string {
	t.Helper()
	_, err := database.CreateUser(context.Background(), username, "$2a$12$fake", roleID)
	if err != nil {
		t.Fatalf("CreateUser %q: %v", username, err)
	}
	token := "chtest-token-" + username
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

	_, _ = database.CreateChannel(context.Background(), "general", "text", "", "", 0)
	_, _ = database.CreateChannel(context.Background(), "random", "text", "", "", 1)

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
	chID, _ := database.CreateChannel(context.Background(), "general", "text", "", "", 0)

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
	user, _ := database.GetUserByUsername(context.Background(), "frank")
	chID, _ := database.CreateChannel(context.Background(), "ch", "text", "", "", 0)

	for i := range 3 {
		_, _ = database.CreateMessage(context.Background(), chID, user.ID, fmt.Sprintf("msg%d", i), nil)
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
	chID, _ := database.CreateChannel(context.Background(), "ch", "text", "", "", 0)

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
	user, _ := database.GetUserByUsername(context.Background(), "henry")
	chID, _ := database.CreateChannel(context.Background(), "ch", "text", "", "", 0)

	for i := range 60 {
		_, _ = database.CreateMessage(context.Background(), chID, user.ID, fmt.Sprintf("m%d", i), nil)
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
	user, _ := database.GetUserByUsername(context.Background(), "ivan")
	chID, _ := database.CreateChannel(context.Background(), "ch", "text", "", "", 0)

	for i := range 5 {
		_, _ = database.CreateMessage(context.Background(), chID, user.ID, fmt.Sprintf("m%d", i), nil)
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
	user, _ := database.GetUserByUsername(context.Background(), "kim")
	chID, _ := database.CreateChannel(context.Background(), "searchable", "text", "", "", 0)
	_, _ = database.CreateMessage(context.Background(), chID, user.ID, "uniqueterm in message", nil)

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

func TestSearch_WithChannelID(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "searchch", 1)
	user, _ := database.GetUserByUsername(context.Background(), "searchch")
	chID, _ := database.CreateChannel(context.Background(), "filtered", "text", "", "", 0)
	_, _ = database.CreateMessage(context.Background(), chID, user.ID, "filtered message here", nil)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/search?q=filtered&channel_id=%d", chID), token)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
}

func TestSearch_InvalidChannelID(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "badchid", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&channel_id=abc", token)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestSearch_NegativeChannelID(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "negchid", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&channel_id=-1", token)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestSearch_WithLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "limituser", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&limit=5", token)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rr.Code)
	}
}

func TestSearch_InvalidLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "badlimit", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&limit=abc", token)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestSearch_InvalidFTSQuery(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "badfts", 1)
	user, _ := database.GetUserByUsername(context.Background(), "badfts")
	chID, _ := database.CreateChannel(context.Background(), "fts", "text", "", "", 0)
	_, _ = database.CreateMessage(context.Background(), chID, user.ID, "search seed", nil)

	// FTS5 operator characters are now stripped by sanitizeFTSQuery, so a
	// bare quote becomes an empty query which returns 200 with no results.
	rr := chGet(t, router, "/api/v1/search?q=%22", token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
}

func TestSearch_ZeroLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "zerolimit", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&limit=0", token)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestSearch_LimitCappedAt100(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "highlimit", 1)

	// limit=200 should be silently capped to 100
	rr := chGet(t, router, "/api/v1/search?q=test&limit=200", token)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rr.Code)
	}
}

func TestSearch_ChannelTypeLookupFailure_FailsClosed(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "searchfailclosed", 1)
	user, _ := database.GetUserByUsername(context.Background(), "searchfailclosed")
	chID, _ := database.CreateChannel(context.Background(), "searchable", "text", "", "", 0)
	_, _ = database.CreateMessage(context.Background(), chID, user.ID, "closedlookupterm", nil)

	_, err := database.ExecContext(context.Background(), `ALTER TABLE channels RENAME TO channels_with_type`)
	if err != nil {
		t.Fatalf("rename channels: %v", err)
	}
	_, err = database.ExecContext(context.Background(), `CREATE TABLE channels (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL
	)`)
	if err != nil {
		t.Fatalf("recreate channels without type: %v", err)
	}
	_, err = database.ExecContext(context.Background(), `INSERT INTO channels (id, name) SELECT id, name FROM channels_with_type`)
	if err != nil {
		t.Fatalf("copy channels: %v", err)
	}

	rr := chGet(t, router, "/api/v1/search?q=closedlookupterm", token)
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body: %s", rr.Code, rr.Body.String())
	}
}

func TestSearch_ChannelOverrideLookupFailure_ReturnsError(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "searchoverridefail", 4)
	user, _ := database.GetUserByUsername(context.Background(), "searchoverridefail")
	chID, _ := database.CreateChannel(context.Background(), "searchable", "text", "", "", 0)
	_, _ = database.CreateMessage(context.Background(), chID, user.ID, "overridefailterm", nil)

	_, err := database.ExecContext(context.Background(), `DROP TABLE channel_overrides`)
	if err != nil {
		t.Fatalf("drop channel_overrides: %v", err)
	}

	rr := chGet(t, router, "/api/v1/search?q=overridefailterm", token)
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body: %s", rr.Code, rr.Body.String())
	}
}

func TestSearch_TrustedProxyRateLimitUsesForwardedIP(t *testing.T) {
	database := newChannelTestDB(t)
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	api.MountChannelRoutes(r, database, svc, limiter, []string{"127.0.0.0/8"}, nil)
	token := chTestCreateToken(t, database, "proxysearch", 1)

	for i := range 30 {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/search?q=test", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("198.51.100.%d", i+1))
		req.RemoteAddr = "127.0.0.1:9999"
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, want 200; body: %s", i, rr.Code, rr.Body.String())
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/search?q=test", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Forwarded-For", "198.51.100.200")
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("independent forwarded client should not be throttled by shared proxy IP, got %d", rr.Code)
	}
}

// ─── Messages — before/after cursor ─────────────────────────────────────────

func TestChannelMessages_BeforeCursor(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "cursoruser", 1)
	user, _ := database.GetUserByUsername(context.Background(), "cursoruser")
	chID, _ := database.CreateChannel(context.Background(), "cursor", "text", "", "", 0)

	var lastID int64
	for i := range 5 {
		lastID, _ = database.CreateMessage(context.Background(), chID, user.ID, fmt.Sprintf("msg%d", i), nil)
	}

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?before=%d", chID, lastID), token)
	if rr.Code != http.StatusOK {
		t.Errorf("before cursor status = %d, want 200", rr.Code)
	}
}

func TestChannelMessages_InvalidLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "badlimituser", 1)
	chID, _ := database.CreateChannel(context.Background(), "lim", "text", "", "", 0)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?limit=abc", chID), token)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("invalid limit status = %d, want 400", rr.Code)
	}
}

// ─── GET /api/v1/channels/{id}/pins ─────────────────────────────────────────

// newPinTestDB creates a DB with dm_participants table needed for pin tests.
func newPinTestDB(t *testing.T) *db.DB {
	t.Helper()
	database := newChannelTestDB(t)
	// Add DM tables required by pin handlers for DM authorization.
	_, err := database.ExecContext(context.Background(), `
		CREATE TABLE IF NOT EXISTS dm_participants (
			channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
			user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
			PRIMARY KEY (channel_id, user_id)
		);
		CREATE INDEX IF NOT EXISTS idx_dm_participants_user ON dm_participants(user_id);
		CREATE TABLE IF NOT EXISTS dm_open_state (
			user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
			channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
			opened_at  TEXT    NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (user_id, channel_id)
		);
		-- Mirrors migration 012. DM pin authorization consults the block list
		-- (a blocked user must not mutate the blocker's pins), so this fixture
		-- needs the table or the lookup fails closed with a 500.
		CREATE TABLE IF NOT EXISTS user_blocks (
			blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at TEXT    NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (blocker_id, blocked_id),
			CHECK (blocker_id != blocked_id)
		);
	`)
	if err != nil {
		t.Fatalf("create dm_participants: %v", err)
	}
	return database
}

func TestGetPins_Unauthenticated(t *testing.T) {
	router := buildChannelRouter(newPinTestDB(t))
	rr := chGet(t, router, "/api/v1/channels/1/pins", "")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
	}
}

func TestGetPins_ChannelNotFound(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinuser1", 1)

	rr := chGet(t, router, "/api/v1/channels/9999/pins", token)
	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body: %s", rr.Code, rr.Body.String())
	}
}

func TestGetPins_EmptyPins(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinuser2", 1)
	chID, _ := database.CreateChannel(context.Background(), "general", "text", "", "", 0)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/pins", chID), token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Messages []any `json:"messages"`
		HasMore  bool  `json:"has_more"`
	}
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if len(resp.Messages) != 0 {
		t.Errorf("expected 0 pinned messages, got %d", len(resp.Messages))
	}
	if resp.HasMore {
		t.Error("has_more should be false for empty pins")
	}
}

func TestGetPins_ReturnsPinnedMessages(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinuser3", 1)
	user, _ := database.GetUserByUsername(context.Background(), "pinuser3")
	chID, _ := database.CreateChannel(context.Background(), "general", "text", "", "", 0)

	msgID, _ := database.CreateMessage(context.Background(), chID, user.ID, "pinned message", nil)
	_ = database.SetMessagePinned(context.Background(), msgID, true)
	// Also create an unpinned message — should not appear.
	_, _ = database.CreateMessage(context.Background(), chID, user.ID, "not pinned", nil)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/pins", chID), token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Messages []any `json:"messages"`
	}
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if len(resp.Messages) != 1 {
		t.Errorf("expected 1 pinned message, got %d", len(resp.Messages))
	}
}

func TestGetPins_DMChannel_NonParticipantForbidden(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)

	// Create two users for the DM and a third who should be denied.
	chTestCreateToken(t, database, "dmuser1", 4)
	chTestCreateToken(t, database, "dmuser2", 4)
	outsiderToken := chTestCreateToken(t, database, "outsider", 4)

	user1, _ := database.GetUserByUsername(context.Background(), "dmuser1")
	user2, _ := database.GetUserByUsername(context.Background(), "dmuser2")

	// Create a DM channel manually.
	dmCh, _, _ := database.GetOrCreateDMChannel(context.Background(), user1.ID, user2.ID)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/pins", dmCh.ID), outsiderToken)
	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body: %s", rr.Code, rr.Body.String())
	}
}

func TestGetPins_MemberNoReadPermission(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	// Role 4 = Member with permissions 1635 (0x663).
	// Deny READ_MESSAGES on a specific channel via override.
	token := chTestCreateToken(t, database, "nopermuser", 4)
	chID, _ := database.CreateChannel(context.Background(), "restricted", "text", "", "", 0)

	// Deny all permissions for role 4 on this channel.
	_, _ = database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, 2147483647)`,
		chID,
	)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/pins", chID), token)
	if rr.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403; body: %s", rr.Code, rr.Body.String())
	}
}

// ─── POST/DELETE /api/v1/channels/{id}/pins/{messageId} ─────────────────────

func chPost(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func chDelete(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
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

func TestSetPinned_PinSuccessfully(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinner1", 1)
	user, _ := database.GetUserByUsername(context.Background(), "pinner1")
	chID, _ := database.CreateChannel(context.Background(), "general", "text", "", "", 0)
	msgID, _ := database.CreateMessage(context.Background(), chID, user.ID, "pin me", nil)

	rr := chPost(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/%d", chID, msgID), token)
	if rr.Code != http.StatusNoContent {
		t.Errorf("pin status = %d, want 204; body: %s", rr.Code, rr.Body.String())
	}

	// Verify the message is actually pinned.
	msg, _ := database.GetMessage(context.Background(), msgID)
	if !msg.Pinned {
		t.Error("message should be pinned after POST")
	}
}

func TestSetPinned_UnpinSuccessfully(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "unpinner1", 1)
	user, _ := database.GetUserByUsername(context.Background(), "unpinner1")
	chID, _ := database.CreateChannel(context.Background(), "general", "text", "", "", 0)
	msgID, _ := database.CreateMessage(context.Background(), chID, user.ID, "unpin me", nil)
	_ = database.SetMessagePinned(context.Background(), msgID, true)

	rr := chDelete(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/%d", chID, msgID), token)
	if rr.Code != http.StatusNoContent {
		t.Errorf("unpin status = %d, want 204; body: %s", rr.Code, rr.Body.String())
	}

	msg, _ := database.GetMessage(context.Background(), msgID)
	if msg.Pinned {
		t.Error("message should not be pinned after DELETE")
	}
}

func TestSetPinned_MessageNotFound(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinner2", 1)
	chID, _ := database.CreateChannel(context.Background(), "general", "text", "", "", 0)

	rr := chPost(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/9999", chID), token)
	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body: %s", rr.Code, rr.Body.String())
	}
}

func TestSetPinned_ChannelNotFound(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinner3", 1)

	rr := chPost(t, router, "/api/v1/channels/9999/pins/1", token)
	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body: %s", rr.Code, rr.Body.String())
	}
}

func TestSetPinned_NoPermission(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	// Member role (4) has permissions 1635 — does not include MANAGE_MESSAGES (0x2000).
	token := chTestCreateToken(t, database, "noperm", 4)
	user, _ := database.GetUserByUsername(context.Background(), "noperm")
	chID, _ := database.CreateChannel(context.Background(), "general", "text", "", "", 0)
	msgID, _ := database.CreateMessage(context.Background(), chID, user.ID, "try to pin", nil)

	rr := chPost(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/%d", chID, msgID), token)
	if rr.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403; body: %s", rr.Code, rr.Body.String())
	}
}

func TestSetPinned_Idempotent(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinner4", 1)
	user, _ := database.GetUserByUsername(context.Background(), "pinner4")
	chID, _ := database.CreateChannel(context.Background(), "general", "text", "", "", 0)
	msgID, _ := database.CreateMessage(context.Background(), chID, user.ID, "already pinned", nil)
	_ = database.SetMessagePinned(context.Background(), msgID, true)

	// Pinning again should still succeed (idempotent).
	rr := chPost(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/%d", chID, msgID), token)
	if rr.Code != http.StatusNoContent {
		t.Errorf("idempotent pin status = %d, want 204; body: %s", rr.Code, rr.Body.String())
	}
}

// ─── POST /api/v1/channels/{id}/messages/purge ──────────────────────────────

// recordingPurgeBroadcaster captures the chat_bulk_deleted fan-out so tests can
// assert one event carries every purged id.
type recordingPurgeBroadcaster struct {
	calls []purgeBroadcast
}

type purgeBroadcast struct {
	channelID int64
	ids       []int64
}

func (b *recordingPurgeBroadcaster) BroadcastChatBulkDeleted(channelID int64, ids []int64) {
	b.calls = append(b.calls, purgeBroadcast{channelID: channelID, ids: ids})
}

// buildPurgeRouter wires the channel routes with a recording broadcaster onto a
// DB that has the DM and audit tables the purge path touches.
func buildPurgeRouter(t *testing.T) (http.Handler, *db.DB, *recordingPurgeBroadcaster) {
	t.Helper()
	database := newPinTestDB(t)
	broadcaster := &recordingPurgeBroadcaster{}
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	api.MountChannelRoutes(r, database, svc, limiter, nil, broadcaster)
	return r, database, broadcaster
}

// chPurge posts a purge body and returns the recorder.
func chPurge(t *testing.T, router http.Handler, channelID int64, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost,
		fmt.Sprintf("/api/v1/channels/%d/messages/purge", channelID), strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

// seedPurgeChannel creates a text channel with n messages authored by username.
func seedPurgeChannel(t *testing.T, database *db.DB, username string, n int) (int64, []int64) {
	t.Helper()
	user, err := database.GetUserByUsername(context.Background(), username)
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername(%q): %v", username, err)
	}
	chID, err := database.CreateChannel(context.Background(), "purge-"+username, "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	ids := make([]int64, 0, n)
	for i := range n {
		id, msgErr := database.CreateMessage(context.Background(), chID, user.ID, fmt.Sprintf("m%d", i), nil)
		if msgErr != nil {
			t.Fatalf("CreateMessage: %v", msgErr)
		}
		ids = append(ids, id)
	}
	return chID, ids
}

type purgeResponseBody struct {
	ChannelID int64   `json:"channel_id"`
	IDs       []int64 `json:"ids"`
	Count     int     `json:"count"`
}

func TestPurgeMessages_ModeratorSucceedsAndBroadcastsOnce(t *testing.T) {
	router, database, broadcaster := buildPurgeRouter(t)
	token := chTestCreateToken(t, database, "purgemod", 3) // Moderator: MANAGE_MESSAGES
	chID, ids := seedPurgeChannel(t, database, "purgemod", 5)

	rr := chPurge(t, router, chID, token, `{"limit":3}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var body purgeResponseBody
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Count != 3 || len(body.IDs) != 3 {
		t.Fatalf("count = %d, ids = %v, want 3 of each", body.Count, body.IDs)
	}
	if body.IDs[0] != ids[4] {
		t.Errorf("ids[0] = %d, want the newest message %d", body.IDs[0], ids[4])
	}

	// One chat_bulk_deleted event, not three chat_deleted ones.
	if len(broadcaster.calls) != 1 {
		t.Fatalf("broadcast calls = %d, want exactly 1", len(broadcaster.calls))
	}
	if broadcaster.calls[0].channelID != chID {
		t.Errorf("broadcast channel = %d, want %d", broadcaster.calls[0].channelID, chID)
	}
	if len(broadcaster.calls[0].ids) != 3 {
		t.Errorf("broadcast ids = %v, want 3 entries", broadcaster.calls[0].ids)
	}

	// Tombstones: the rows survive, flagged deleted.
	for _, id := range body.IDs {
		msg, _ := database.GetMessage(context.Background(), id)
		if msg == nil || !msg.Deleted {
			t.Errorf("message %d is not a surviving tombstone", id)
		}
	}
	// The two oldest are untouched.
	for _, id := range ids[:2] {
		msg, _ := database.GetMessage(context.Background(), id)
		if msg.Deleted {
			t.Errorf("message %d outside the purge window was deleted", id)
		}
	}
}

func TestPurgeMessages_MemberForbidden(t *testing.T) {
	router, database, broadcaster := buildPurgeRouter(t)
	token := chTestCreateToken(t, database, "purgemember", 4) // Member: no MANAGE_MESSAGES
	chID, ids := seedPurgeChannel(t, database, "purgemember", 3)

	rr := chPurge(t, router, chID, token, `{"limit":3}`)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body: %s", rr.Code, rr.Body.String())
	}
	if len(broadcaster.calls) != 0 {
		t.Errorf("denied purge still broadcast: %v", broadcaster.calls)
	}
	for _, id := range ids {
		msg, _ := database.GetMessage(context.Background(), id)
		if msg.Deleted {
			t.Errorf("denied purge deleted message %d", id)
		}
	}
}

func TestPurgeMessages_DMForbidden(t *testing.T) {
	router, database, broadcaster := buildPurgeRouter(t)
	token := chTestCreateToken(t, database, "purgedmmod", 1) // Owner — every bit set
	user, _ := database.GetUserByUsername(context.Background(), "purgedmmod")
	dmID, _ := database.CreateChannel(context.Background(), "dm", "dm", "", "", 0)
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?)`, dmID, user.ID); err != nil {
		t.Fatalf("seed dm participant: %v", err)
	}
	msgID, _ := database.CreateMessage(context.Background(), dmID, user.ID, "private", nil)

	rr := chPurge(t, router, dmID, token, `{"limit":10}`)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for a DM; body: %s", rr.Code, rr.Body.String())
	}
	if len(broadcaster.calls) != 0 {
		t.Errorf("DM purge broadcast: %v", broadcaster.calls)
	}
	msg, _ := database.GetMessage(context.Background(), msgID)
	if msg.Deleted {
		t.Error("DM message was purged")
	}
}

func TestPurgeMessages_LimitClampedToHundred(t *testing.T) {
	router, database, _ := buildPurgeRouter(t)
	token := chTestCreateToken(t, database, "purgeclamp", 3)
	chID, _ := seedPurgeChannel(t, database, "purgeclamp", 105)

	rr := chPurge(t, router, chID, token, `{"limit":1000}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var body purgeResponseBody
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Count != 100 {
		t.Fatalf("count = %d, want the clamp of 100", body.Count)
	}
}

func TestPurgeMessages_BadRequests(t *testing.T) {
	router, database, _ := buildPurgeRouter(t)
	token := chTestCreateToken(t, database, "purgebad", 3)
	chID, _ := seedPurgeChannel(t, database, "purgebad", 2)

	cases := []struct {
		name string
		body string
	}{
		{"zero limit", `{"limit":0}`},
		{"negative limit", `{"limit":-5}`},
		{"malformed json", `{"limit":`},
		{"negative before", `{"limit":5,"before":-1}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr := chPurge(t, router, chID, token, tc.body)
			if rr.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400; body: %s", rr.Code, rr.Body.String())
			}
		})
	}
}

func TestPurgeMessages_Unauthenticated(t *testing.T) {
	router, database, _ := buildPurgeRouter(t)
	chTestCreateToken(t, database, "purgeanon", 3)
	chID, _ := seedPurgeChannel(t, database, "purgeanon", 2)

	rr := chPurge(t, router, chID, "", `{"limit":2}`)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401; body: %s", rr.Code, rr.Body.String())
	}
}

func TestPurgeMessages_EmptyChannelDoesNotBroadcast(t *testing.T) {
	router, database, broadcaster := buildPurgeRouter(t)
	token := chTestCreateToken(t, database, "purgeempty", 3)
	chID, _ := seedPurgeChannel(t, database, "purgeempty", 0)

	rr := chPurge(t, router, chID, token, `{"limit":50}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var body purgeResponseBody
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Count != 0 || body.IDs == nil {
		t.Errorf("count = %d, ids = %v, want 0 and a non-null array", body.Count, body.IDs)
	}
	if len(broadcaster.calls) != 0 {
		t.Errorf("a no-op purge broadcast: %v", broadcaster.calls)
	}
}

func TestPurgeMessages_NilBroadcasterStillPurges(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database) // mounted with a nil broadcaster
	token := chTestCreateToken(t, database, "purgenilbc", 3)
	chID, ids := seedPurgeChannel(t, database, "purgenilbc", 2)

	rr := chPurge(t, router, chID, token, `{"limit":2}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	for _, id := range ids {
		msg, _ := database.GetMessage(context.Background(), id)
		if !msg.Deleted {
			t.Errorf("message %d not purged", id)
		}
	}
}
