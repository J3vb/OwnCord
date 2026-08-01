package ws_test

// coverage_helpers_test.go holds the shared schema, hub constructors, and
// drain/seed helpers used by the coverage_* test files (split from the former
// coverage_boost_test.go, which added tests for low-coverage functions).

import (
	"context"
	"encoding/json"
	"testing"
	"testing/fstest"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
	"github.com/owncord/server/ws"
)

// ─── schema with voice_states + audit_log for coverage tests ──────────────────

var coverageSchema = append(hubTestSchema, []byte(`
CREATE TABLE IF NOT EXISTS voice_states (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    muted       INTEGER NOT NULL DEFAULT 0,
    deafened    INTEGER NOT NULL DEFAULT 0,
    speaking    INTEGER NOT NULL DEFAULT 0,
    camera      INTEGER NOT NULL DEFAULT 0,
    screenshare INTEGER NOT NULL DEFAULT 0,
    server_muted    INTEGER NOT NULL DEFAULT 0,
    server_deafened INTEGER NOT NULL DEFAULT 0,
    joined_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_states_channel_cov ON voice_states(channel_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER NOT NULL REFERENCES users(id),
    action      TEXT    NOT NULL,
    target_type TEXT    NOT NULL DEFAULT '',
    target_id   INTEGER NOT NULL DEFAULT 0,
    detail      TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT    PRIMARY KEY,
    message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    uploader_id INTEGER REFERENCES users(id),
    filename    TEXT    NOT NULL,
    stored_as   TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_at TEXT    NOT NULL DEFAULT (datetime('now')),
    width       INTEGER,
    height      INTEGER
);

`)...)

func openCoverageDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: coverageSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

func newCoverageHub(t *testing.T) (*ws.Hub, *db.DB) {
	t.Helper()
	database := openCoverageDB(t)
	limiter := auth.NewRateLimiter()
	st := database
	svc := service.New(st, limiter)
	hub := ws.NewHub(database, limiter, svc)

	// Inject a test LiveKit client so voice_join passes the livekit!=nil guard.
	lk, err := ws.NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "test-api-key-12345",
		LiveKitAPISecret: "test-api-secret-67890abcdef",
		LiveKitURL:       "ws://localhost:7880",
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	hub.SetLiveKit(lk)

	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	return hub, database
}

func seedCoverageOwner(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	_, err := database.CreateUser(context.Background(), username, "hash", 1)
	if err != nil {
		t.Fatalf("seedCoverageOwner CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername(context.Background(), username)
	if err != nil || user == nil {
		t.Fatalf("seedCoverageOwner GetUserByUsername: %v", err)
	}
	return user
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// drainForErrorCode reads from ch until an error message is found or deadline passes.
func drainForErrorCode(ch <-chan []byte, deadline time.Duration) string {
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	for {
		select {
		case msg := <-ch:
			var env map[string]any
			if err := json.Unmarshal(msg, &env); err != nil {
				continue
			}
			if env["type"] == "error" {
				if payload, ok := env["payload"].(map[string]any); ok {
					code, _ := payload["code"].(string)
					return code
				}
			}
		case <-timer.C:
			return ""
		}
	}
}

// drainChanBuf drains all buffered messages from a channel.
func drainChanBuf(ch <-chan []byte) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

// drainChanTimeout reads messages until timeout, returning all collected.
func drainChanTimeout(ch <-chan []byte, d time.Duration) [][]byte {
	var msgs [][]byte
	timer := time.NewTimer(d)
	defer timer.Stop()
	for {
		select {
		case msg := <-ch:
			msgs = append(msgs, msg)
		case <-timer.C:
			return msgs
		}
	}
}

func seedVoiceChannel(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	id, err := database.CreateChannel(context.Background(), name, "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel voice: %v", err)
	}
	return id
}

func voiceTokenRefreshMsg() []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_token_refresh",
		"payload": map[string]any{},
	})
	return raw
}
