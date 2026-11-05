package api_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// ─── schema for channel tests ─────────────────────────────────────────────────

var channelTestSchema = []byte(schemaAccounts + schemaMessaging + schemaPolls + `
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
    thread_post_message_id INTEGER,
    is_group         INTEGER NOT NULL DEFAULT 0,
    dm_owner_id      INTEGER,
    dm_icon      TEXT
);
CREATE TABLE IF NOT EXISTS forum_tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    forum_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    emoji      TEXT,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE TABLE IF NOT EXISTS thread_tags (
    thread_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES forum_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (thread_id, tag_id)
);
CREATE TABLE IF NOT EXISTS thread_members (
    thread_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (thread_id, user_id)
) WITHOUT ROWID;
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
CREATE INDEX IF NOT EXISTS idx_dm_participants_user ON dm_participants(user_id);
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER NOT NULL DEFAULT 0,
    action      TEXT    NOT NULL,
    target_type TEXT    NOT NULL DEFAULT '',
    target_id   INTEGER NOT NULL DEFAULT 0,
    detail      TEXT    NOT NULL DEFAULT '',
    subject_token TEXT,
    actor_token TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
`)

// ─── helpers ──────────────────────────────────────────────────────────────────

func newChannelTestDB(t *testing.T) *db.DB {
	t.Helper()
	return openSchemaDB(t, channelTestSchema)
}

func buildChannelRouter(database *db.DB) http.Handler {
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	st := database
	svc := service.New(st, limiter)
	api.MountChannelRoutes(r, svc, limiter, nil, nil)
	return r
}

// chTestCreateToken creates a user+session and returns the plaintext token.
func chTestCreateToken(t *testing.T, database *db.DB, username string, roleID int) string {
	t.Helper()
	return createUserToken(t, database, "chtest-token-", username, roleID)
}

// newChannelRouterAs mounts the channel routes over database and creates a
// user with roleID, returning the router and the user's bearer token.
func newChannelRouterAs(t *testing.T, database *db.DB, username string, roleID int) (http.Handler, string) {
	t.Helper()
	return buildChannelRouter(database), chTestCreateToken(t, database, username, roleID)
}

// newChannelEnvOn is newChannelRouterAs plus the user's row and a channel of
// the given name and type.
func newChannelEnvOn(t *testing.T, database *db.DB, username string, roleID int, channelName, chanType string) (http.Handler, string, *db.User, int64) {
	t.Helper()
	router, token := newChannelRouterAs(t, database, username, roleID)
	user, err := database.GetUserByUsername(context.Background(), username)
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername(%s): %v", username, err)
	}
	return router, token, user, mustCreateChannel(t, database, channelName, chanType)
}

// newChannelEnv is newChannelEnvOn over a fresh channel-schema database.
func newChannelEnv(t *testing.T, username string, roleID int, channelName, chanType string) (*db.DB, http.Handler, string, *db.User, int64) {
	t.Helper()
	database := newChannelTestDB(t)
	router, token, user, chID := newChannelEnvOn(t, database, username, roleID, channelName, chanType)
	return database, router, token, user, chID
}

func chGet(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	return doAPI(t, router, http.MethodGet, path, token, nil)
}

// ─── GET /api/v1/channels ─────────────────────────────────────────────────────

func TestChannelList_Unauthenticated(t *testing.T) {
	router := buildChannelRouter(newChannelTestDB(t))
	rr := chGet(t, router, "/api/v1/channels", "")
	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestChannelList_Empty(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "alice", 1)

	rr := chGet(t, router, "/api/v1/channels", token)
	expectStatus(t, rr, http.StatusOK)
	resp := decodeBody[[]any](t, rr)
	if len(resp) != 0 {
		t.Errorf("expected empty array, got %d items", len(resp))
	}
}

func TestChannelList_WithChannels(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "bob", 1)

	_, _ = database.CreateChannel(context.Background(), "general", "text", "", "", 0)
	_, _ = database.CreateChannel(context.Background(), "random", "text", "", "", 1)

	rr := chGet(t, router, "/api/v1/channels", token)
	expectStatus(t, rr, http.StatusOK)
	resp := decodeBody[[]any](t, rr)
	if len(resp) != 2 {
		t.Errorf("expected 2 channels, got %d", len(resp))
	}
}

// ─── GET /api/v1/channels/{id}/messages ──────────────────────────────────────

func TestChannelMessages_Unauthenticated(t *testing.T) {
	router := buildChannelRouter(newChannelTestDB(t))
	rr := chGet(t, router, "/api/v1/channels/1/messages", "")
	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestChannelMessages_InvalidID(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "carol", 1)

	rr := chGet(t, router, "/api/v1/channels/abc/messages", token)
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestChannelMessages_ChannelNotFound(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "dave", 1)

	rr := chGet(t, router, "/api/v1/channels/9999/messages", token)
	expectStatus(t, rr, http.StatusNotFound)
}

func TestChannelMessages_EmptyChannel(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "eve", 1)
	chID := mustCreateChannel(t, database, "general", "text")

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages", chID), token)
	expectStatus(t, rr, http.StatusOK)
	resp := decodeBody[map[string]any](t, rr)
	msgs, ok := resp["messages"].([]any)
	if !ok || len(msgs) != 0 {
		t.Errorf("expected empty messages array, got: %v", resp["messages"])
	}
}

func TestChannelMessages_ReturnsMessages(t *testing.T) {
	database, router, token, user, chID := newChannelEnv(t, "frank", 1, "ch", "text")

	for i := range 3 {
		_ = mustCreateMessage(t, database, chID, user.ID, fmt.Sprintf("msg%d", i))
	}

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages", chID), token)
	expectStatus(t, rr, http.StatusOK)
	resp := decodeBody[map[string]any](t, rr)
	msgs := resp["messages"].([]any)
	if len(msgs) != 3 {
		t.Errorf("expected 3 messages, got %d", len(msgs))
	}
}

func TestChannelMessages_LimitCappedAt100(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "grace", 1)
	chID := mustCreateChannel(t, database, "ch", "text")

	// limit=200 should succeed (capped internally).
	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?limit=200", chID), token)
	expectStatus(t, rr, http.StatusOK)
}

func TestChannelMessages_HasMore(t *testing.T) {
	database, router, token, user, chID := newChannelEnv(t, "henry", 1, "ch", "text")

	for i := range 60 {
		_ = mustCreateMessage(t, database, chID, user.ID, fmt.Sprintf("m%d", i))
	}

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?limit=50", chID), token)
	expectStatus(t, rr, http.StatusOK)
	resp := decodeBody[map[string]any](t, rr)
	if resp["has_more"] != true {
		t.Errorf("has_more = %v, want true", resp["has_more"])
	}
}

func TestChannelMessages_HasMoreFalse(t *testing.T) {
	database, router, token, user, chID := newChannelEnv(t, "ivan", 1, "ch", "text")

	for i := range 5 {
		_ = mustCreateMessage(t, database, chID, user.ID, fmt.Sprintf("m%d", i))
	}

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?limit=50", chID), token)
	expectStatus(t, rr, http.StatusOK)
	resp := decodeBody[map[string]any](t, rr)
	if resp["has_more"] != false {
		t.Errorf("has_more = %v, want false", resp["has_more"])
	}
}

// ─── GET /api/v1/search ───────────────────────────────────────────────────────

func TestSearch_Unauthenticated(t *testing.T) {
	router := buildChannelRouter(newChannelTestDB(t))
	rr := chGet(t, router, "/api/v1/search?q=hello", "")
	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestSearch_MissingQuery(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "julia", 1)

	rr := chGet(t, router, "/api/v1/search", token)
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestSearch_ReturnsResults(t *testing.T) {
	database, router, token, user, chID := newChannelEnv(t, "kim", 1, "searchable", "text")
	_ = mustCreateMessage(t, database, chID, user.ID, "uniqueterm in message")

	rr := chGet(t, router, "/api/v1/search?q=uniqueterm", token)
	expectStatus(t, rr, http.StatusOK)
	resp := decodeBody[map[string]any](t, rr)
	results, ok := resp["results"].([]any)
	if !ok || len(results) == 0 {
		t.Errorf("expected search results, got: %v", resp)
	}
}

func TestSearch_NoResults(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "larry", 1)

	rr := chGet(t, router, "/api/v1/search?q=xyzzynotfound", token)
	expectStatus(t, rr, http.StatusOK)
	resp := decodeBody[map[string]any](t, rr)
	results := resp["results"].([]any)
	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}
}

func TestSearch_WithChannelID(t *testing.T) {
	database, router, token, user, chID := newChannelEnv(t, "searchch", 1, "filtered", "text")
	_ = mustCreateMessage(t, database, chID, user.ID, "filtered message here")

	rr := chGet(t, router, fmt.Sprintf("/api/v1/search?q=filtered&channel_id=%d", chID), token)
	expectStatus(t, rr, http.StatusOK)
}

func TestSearch_InvalidChannelID(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "badchid", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&channel_id=abc", token)
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestSearch_NegativeChannelID(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "negchid", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&channel_id=-1", token)
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestSearch_WithLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "limituser", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&limit=5", token)
	expectStatus(t, rr, http.StatusOK)
}

func TestSearch_InvalidLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "badlimit", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&limit=abc", token)
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestSearch_InvalidFTSQuery(t *testing.T) {
	database, router, token, user, chID := newChannelEnv(t, "badfts", 1, "fts", "text")
	_ = mustCreateMessage(t, database, chID, user.ID, "search seed")

	// FTS5 operator characters are now stripped by sanitizeFTSQuery, so a
	// bare quote becomes an empty query which returns 200 with no results.
	rr := chGet(t, router, "/api/v1/search?q=%22", token)
	requireStatus(t, rr, http.StatusOK)
}

func TestSearch_ZeroLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "zerolimit", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&limit=0", token)
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestSearch_LimitCappedAt100(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "highlimit", 1)

	// limit=200 should be silently capped to 100
	rr := chGet(t, router, "/api/v1/search?q=test&limit=200", token)
	expectStatus(t, rr, http.StatusOK)
}

// searchPage decodes a /api/v1/search response into its hit ids and cursor.
func searchPage(t *testing.T, rr *httptest.ResponseRecorder) (ids []int64, nextBefore *int64) {
	t.Helper()
	requireStatus(t, rr, http.StatusOK)
	resp := decodeBody[struct {
		Results []struct {
			MessageID int64 `json:"message_id"`
		} `json:"results"`
		NextBefore *int64 `json:"next_before"`
	}](t, rr)
	for _, r := range resp.Results {
		ids = append(ids, r.MessageID)
	}
	return ids, resp.NextBefore
}

// DP-20: sort=recent pages newest first through next_before; every page
// holds only ids strictly below the cursor it was asked with.
func TestSearch_SortRecentPagesWithBefore(t *testing.T) {
	database, router, token, user, chID := newChannelEnv(t, "recentpager", 1, "pager", "text")
	ids := make([]int64, 5)
	for i := range ids {
		ids[i], _ = database.CreateMessage(context.Background(), chID, user.ID, "pagerword hit", nil)
	}

	got, next := searchPage(t, chGet(t, router, "/api/v1/search?q=pagerword&sort=recent&limit=2", token))
	if !slices.Equal(got, []int64{ids[4], ids[3]}) || next == nil || *next != ids[3] {
		t.Fatalf("page 1 = %v next_before %v, want [%d %d] next_before %d", got, next, ids[4], ids[3], ids[3])
	}
	got, next = searchPage(t, chGet(t, router, fmt.Sprintf("/api/v1/search?q=pagerword&sort=recent&limit=2&before=%d", *next), token))
	if !slices.Equal(got, []int64{ids[2], ids[1]}) || next == nil || *next != ids[1] {
		t.Fatalf("page 2 = %v next_before %v, want [%d %d] next_before %d", got, next, ids[2], ids[1], ids[1])
	}
	got, next = searchPage(t, chGet(t, router, fmt.Sprintf("/api/v1/search?q=pagerword&sort=recent&limit=2&before=%d", *next), token))
	if !slices.Equal(got, []int64{ids[0]}) || next != nil {
		t.Fatalf("page 3 = %v next_before %v, want [%d] and no cursor", got, next, ids[0])
	}

	// The default stays rank order with no cursor, however many hits remain.
	got, next = searchPage(t, chGet(t, router, "/api/v1/search?q=pagerword&limit=2", token))
	if len(got) != 2 || next != nil {
		t.Errorf("default page = %v next_before %v, want 2 hits and no cursor", got, next)
	}
	got, _ = searchPage(t, chGet(t, router, "/api/v1/search?q=pagerword&sort=relevance", token))
	if len(got) != 5 {
		t.Errorf("sort=relevance = %d hits, want 5", len(got))
	}
}

func TestSearch_InvalidSortOrCursor(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "badcursor", 1)

	for _, q := range []string{
		"sort=newest",
		"sort=recent&before=abc",
		"sort=recent&before=0",
		"sort=recent&before=-5",
		"before=10",                // a cursor only means something newest first
		"sort=relevance&before=10", // likewise
	} {
		rr := chGet(t, router, "/api/v1/search?q=test&"+q, token)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", q, rr.Code)
		}
	}
}

func TestSearch_ChannelTypeLookupFailure_FailsClosed(t *testing.T) {
	database, router, token, user, chID := newChannelEnv(t, "searchfailclosed", 1, "searchable", "text")
	_ = mustCreateMessage(t, database, chID, user.ID, "closedlookupterm")

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
	requireStatus(t, rr, http.StatusInternalServerError)
}

func TestSearch_ChannelOverrideLookupFailure_ReturnsError(t *testing.T) {
	database, router, token, user, chID := newChannelEnv(t, "searchoverridefail", 4, "searchable", "text")
	_ = mustCreateMessage(t, database, chID, user.ID, "overridefailterm")

	_, err := database.ExecContext(context.Background(), `DROP TABLE channel_overrides`)
	if err != nil {
		t.Fatalf("drop channel_overrides: %v", err)
	}

	rr := chGet(t, router, "/api/v1/search?q=overridefailterm", token)
	requireStatus(t, rr, http.StatusInternalServerError)
}

func TestSearch_TrustedProxyRateLimitUsesForwardedIP(t *testing.T) {
	database := newChannelTestDB(t)
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	api.MountChannelRoutes(r, svc, limiter, []string{"127.0.0.0/8"}, nil)
	token := chTestCreateToken(t, database, "proxysearch", 1)

	for i := range 30 {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/search?q=test", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("198.51.100.%d", i+1))
		rr := serveLocal(r, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, want 200; body: %s", i, rr.Code, rr.Body.String())
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/search?q=test", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Forwarded-For", "198.51.100.200")
	rr := serveLocal(r, req)
	requireStatus(t, rr, http.StatusOK)
}

// ─── Messages — before/after cursor ─────────────────────────────────────────

func TestChannelMessages_BeforeCursor(t *testing.T) {
	database, router, token, user, chID := newChannelEnv(t, "cursoruser", 1, "cursor", "text")

	var lastID int64
	for i := range 5 {
		lastID, _ = database.CreateMessage(context.Background(), chID, user.ID, fmt.Sprintf("msg%d", i), nil)
	}

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?before=%d", chID, lastID), token)
	expectStatus(t, rr, http.StatusOK)
}

func TestChannelMessages_InvalidLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "badlimituser", 1)
	chID := mustCreateChannel(t, database, "lim", "text")

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?limit=abc", chID), token)
	expectStatus(t, rr, http.StatusBadRequest)
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
		-- DM pin authorization also reads the recipient's DM privacy (migration
		-- 070) and trust rows (migration 046) through the same gate.
		CREATE TABLE IF NOT EXISTS user_privacy (
			user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			allow_member_dms  INTEGER NOT NULL DEFAULT 1 CHECK (allow_member_dms IN (0, 1)),
			message_requests  INTEGER NOT NULL DEFAULT 1 CHECK (message_requests IN (0, 1)),
			updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
		);
		CREATE TABLE IF NOT EXISTS trusted_senders (
			recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			source       TEXT    NOT NULL CHECK (source IN ('accepted', 'sent_first', 'grandfathered')),
			created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (recipient_id, sender_id)
		);
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
	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestGetPins_ChannelNotFound(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinuser1", 1)

	rr := chGet(t, router, "/api/v1/channels/9999/pins", token)
	expectStatus(t, rr, http.StatusNotFound)
}

func TestGetPins_EmptyPins(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinuser2", 1)
	chID := mustCreateChannel(t, database, "general", "text")

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/pins", chID), token)
	requireStatus(t, rr, http.StatusOK)

	resp := decodeBody[struct {
		Messages []any `json:"messages"`
		HasMore  bool  `json:"has_more"`
	}](t, rr)
	if len(resp.Messages) != 0 {
		t.Errorf("expected 0 pinned messages, got %d", len(resp.Messages))
	}
	if resp.HasMore {
		t.Error("has_more should be false for empty pins")
	}
}

func TestGetPins_ReturnsPinnedMessages(t *testing.T) {
	database := newPinTestDB(t)
	router, token, user, chID := newChannelEnvOn(t, database, "pinuser3", 1, "general", "text")

	msgID := mustCreateMessage(t, database, chID, user.ID, "pinned message")
	if _, err := database.SetMessagePinned(context.Background(), db.SetPinnedParams{MessageID: msgID, Pinned: true, UserID: user.ID}); err != nil {
		t.Fatalf("SetMessagePinned: %v", err)
	}
	// Also create an unpinned message — should not appear.
	_ = mustCreateMessage(t, database, chID, user.ID, "not pinned")

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/pins", chID), token)
	requireStatus(t, rr, http.StatusOK)

	resp := decodeBody[struct {
		Messages []any `json:"messages"`
	}](t, rr)
	if len(resp.Messages) != 1 {
		t.Errorf("expected 1 pinned message, got %d", len(resp.Messages))
	}
}

// TestGetPins_HasMoreOnlyPastCap: exactly MaxPinnedMessages pins is the whole
// list (has_more false); one more pin is truncated to the cap (has_more true).
func TestGetPins_HasMoreOnlyPastCap(t *testing.T) {
	database := newPinTestDB(t)
	router, token, user, chID := newChannelEnvOn(t, database, "pincap", 1, "general", "text")

	pin := func() {
		t.Helper()
		id := mustCreateMessage(t, database, chID, user.ID, "pin")
		if _, err := database.SetMessagePinned(context.Background(), db.SetPinnedParams{MessageID: id, Pinned: true, UserID: 1}); err != nil {
			t.Fatalf("SetMessagePinned: %v", err)
		}
	}
	get := func() (int, bool) {
		t.Helper()
		rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/pins", chID), token)
		requireStatus(t, rr, http.StatusOK)
		resp := decodeBody[struct {
			Messages []any `json:"messages"`
			HasMore  bool  `json:"has_more"`
		}](t, rr)
		return len(resp.Messages), resp.HasMore
	}

	for range db.MaxPinnedMessages {
		pin()
	}
	if n, more := get(); n != db.MaxPinnedMessages || more {
		t.Errorf("at the cap: got %d pins, has_more=%v; want %d, false", n, more, db.MaxPinnedMessages)
	}

	pin()
	if n, more := get(); n != db.MaxPinnedMessages || !more {
		t.Errorf("past the cap: got %d pins, has_more=%v; want %d, true", n, more, db.MaxPinnedMessages)
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
	expectStatus(t, rr, http.StatusNotFound)
}

func TestGetPins_MemberNoReadPermission(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	// Role 4 = Member with permissions 1635 (0x663).
	// Deny READ_MESSAGES on a specific channel via override.
	token := chTestCreateToken(t, database, "nopermuser", 4)
	chID := mustCreateChannel(t, database, "restricted", "text")

	// Deny all permissions for role 4 on this channel.
	_, _ = database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, 2147483647)`,
		chID,
	)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/pins", chID), token)
	expectStatus(t, rr, http.StatusForbidden)
}

// ─── POST/DELETE /api/v1/channels/{id}/pins/{messageId} ─────────────────────

func chPost(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	return doAPI(t, router, http.MethodPost, path, token, nil)
}

func chDelete(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	return doAPI(t, router, http.MethodDelete, path, token, nil)
}

func TestSetPinned_PinSuccessfully(t *testing.T) {
	database := newPinTestDB(t)
	router, token, user, chID := newChannelEnvOn(t, database, "pinner1", 1, "general", "text")
	msgID := mustCreateMessage(t, database, chID, user.ID, "pin me")

	rr := chPost(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/%d", chID, msgID), token)
	expectStatus(t, rr, http.StatusNoContent)

	// Verify the message is actually pinned.
	msg, _ := database.GetMessage(context.Background(), msgID)
	if !msg.Pinned {
		t.Error("message should be pinned after POST")
	}
}

func TestSetPinned_UnpinSuccessfully(t *testing.T) {
	database := newPinTestDB(t)
	router, token, user, chID := newChannelEnvOn(t, database, "unpinner1", 1, "general", "text")
	msgID := mustCreateMessage(t, database, chID, user.ID, "unpin me")
	if _, err := database.SetMessagePinned(context.Background(), db.SetPinnedParams{MessageID: msgID, Pinned: true, UserID: user.ID}); err != nil {
		t.Fatalf("SetMessagePinned: %v", err)
	}

	rr := chDelete(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/%d", chID, msgID), token)
	expectStatus(t, rr, http.StatusNoContent)

	msg, _ := database.GetMessage(context.Background(), msgID)
	if msg.Pinned {
		t.Error("message should not be pinned after DELETE")
	}
}

func TestSetPinned_MessageNotFound(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinner2", 1)
	chID := mustCreateChannel(t, database, "general", "text")

	rr := chPost(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/9999", chID), token)
	expectStatus(t, rr, http.StatusNotFound)
}

func TestSetPinned_ChannelNotFound(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinner3", 1)

	rr := chPost(t, router, "/api/v1/channels/9999/pins/1", token)
	expectStatus(t, rr, http.StatusNotFound)
}

func TestSetPinned_NoPermission(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	// Member role (4) has permissions 1635 — does not include MANAGE_MESSAGES (0x2000).
	token := chTestCreateToken(t, database, "noperm", 4)
	user, _ := database.GetUserByUsername(context.Background(), "noperm")
	chID := mustCreateChannel(t, database, "general", "text")
	msgID := mustCreateMessage(t, database, chID, user.ID, "try to pin")

	rr := chPost(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/%d", chID, msgID), token)
	expectStatus(t, rr, http.StatusForbidden)
}

func TestSetPinned_Idempotent(t *testing.T) {
	database := newPinTestDB(t)
	router, token, user, chID := newChannelEnvOn(t, database, "pinner4", 1, "general", "text")
	msgID := mustCreateMessage(t, database, chID, user.ID, "already pinned")
	if _, err := database.SetMessagePinned(context.Background(), db.SetPinnedParams{MessageID: msgID, Pinned: true, UserID: user.ID}); err != nil {
		t.Fatalf("SetMessagePinned: %v", err)
	}

	// Pinning again should still succeed (idempotent).
	rr := chPost(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/%d", chID, msgID), token)
	expectStatus(t, rr, http.StatusNoContent)
}

// ─── POST /api/v1/channels/{id}/messages/purge ──────────────────────────────

// recordingPurgeBroadcaster captures the chat_bulk_deleted fan-out so tests can
// assert one event carries every purged id.
type recordingPurgeBroadcaster struct {
	calls []purgeBroadcast
	// pinRows records every PinEventRow fan-out (WP 6.12).
	pinRows []*service.PinEventResult
}

type purgeBroadcast struct {
	channelID int64
	ids       []int64
}

func (b *recordingPurgeBroadcaster) BroadcastChatBulkDeleted(channelID int64, ids []int64) {
	b.calls = append(b.calls, purgeBroadcast{channelID: channelID, ids: ids})
}

// BroadcastMessagePinned satisfies PurgeBroadcaster; the pin fan-out itself is
// asserted in ws/messages_test.go.
func (b *recordingPurgeBroadcaster) BroadcastMessagePinned(_ int64, _ int64, _ bool) {}

// PinEventRow records the pin row fan-out.
func (b *recordingPurgeBroadcaster) PinEventRow(_ context.Context, res *service.PinEventResult) {
	b.pinRows = append(b.pinRows, res)
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
	api.MountChannelRoutes(r, svc, limiter, nil, broadcaster)
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
	rr := serveLocal(router, req)
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
	requireStatus(t, rr, http.StatusOK)

	body := decodeBody[purgeResponseBody](t, rr)
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
	requireStatus(t, rr, http.StatusForbidden)
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
	dmID := mustCreateChannel(t, database, "dm", "dm")
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?)`, dmID, user.ID); err != nil {
		t.Fatalf("seed dm participant: %v", err)
	}
	msgID := mustCreateMessage(t, database, dmID, user.ID, "private")

	rr := chPurge(t, router, dmID, token, `{"limit":10}`)
	requireStatus(t, rr, http.StatusForbidden)
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
	requireStatus(t, rr, http.StatusOK)
	body := decodeBody[purgeResponseBody](t, rr)
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
			expectStatus(t, rr, http.StatusBadRequest)
		})
	}
}

func TestPurgeMessages_Unauthenticated(t *testing.T) {
	router, database, _ := buildPurgeRouter(t)
	chTestCreateToken(t, database, "purgeanon", 3)
	chID, _ := seedPurgeChannel(t, database, "purgeanon", 2)

	rr := chPurge(t, router, chID, "", `{"limit":2}`)
	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestPurgeMessages_EmptyChannelDoesNotBroadcast(t *testing.T) {
	router, database, broadcaster := buildPurgeRouter(t)
	token := chTestCreateToken(t, database, "purgeempty", 3)
	chID, _ := seedPurgeChannel(t, database, "purgeempty", 0)

	rr := chPurge(t, router, chID, token, `{"limit":50}`)
	requireStatus(t, rr, http.StatusOK)
	body := decodeBody[purgeResponseBody](t, rr)
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
	requireStatus(t, rr, http.StatusOK)
	for _, id := range ids {
		msg, _ := database.GetMessage(context.Background(), id)
		if !msg.Deleted {
			t.Errorf("message %d not purged", id)
		}
	}
}

// ─── pin row fan-out (WP 6.12) ──────────────────────────────────────────────

func TestHandleSetPinned_EmitsRowOnce(t *testing.T) {
	router, database, broadcaster := buildPurgeRouter(t)
	token := chTestCreateToken(t, database, "pinrow", 1)
	user, _ := database.GetUserByUsername(context.Background(), "pinrow")
	chID := mustCreateChannel(t, database, "pinrows", "text")
	msgID := mustCreateMessage(t, database, chID, user.ID, "pin me")
	path := fmt.Sprintf("/api/v1/channels/%d/pins/%d", chID, msgID)

	if rr := chPost(t, router, path, token); rr.Code != http.StatusNoContent {
		t.Fatalf("pin status = %d, want 204; body: %s", rr.Code, rr.Body.String())
	}
	if len(broadcaster.pinRows) != 1 {
		t.Fatalf("pin row fan-outs after a pin = %d, want 1", len(broadcaster.pinRows))
	}
	got := broadcaster.pinRows[0]
	if got.Row.PinnedMessageID != msgID || got.Row.ChannelID != chID || got.Author.ID != user.ID {
		t.Errorf("fan-out = %+v (author %+v), want target %d channel %d author %d", got.Row, got.Author, msgID, chID, user.ID)
	}

	// A re-pin, an unpin and a flap inside the window emit nothing more.
	if rr := chPost(t, router, path, token); rr.Code != http.StatusNoContent {
		t.Fatalf("re-pin status = %d", rr.Code)
	}
	if rr := chDelete(t, router, path, token); rr.Code != http.StatusNoContent {
		t.Fatalf("unpin status = %d", rr.Code)
	}
	if rr := chPost(t, router, path, token); rr.Code != http.StatusNoContent {
		t.Fatalf("flap pin status = %d", rr.Code)
	}
	if len(broadcaster.pinRows) != 1 {
		t.Errorf("pin row fan-outs after re-pin, unpin and flap = %d, want still 1", len(broadcaster.pinRows))
	}
}
