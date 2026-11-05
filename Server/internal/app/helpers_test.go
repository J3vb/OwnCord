package app

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// mustExec runs one statement against database and fails the test on error.
func mustExec(t testing.TB, database *db.DB, query string, args ...any) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(), query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

// disableScheduledBackup turns the migration-seeded daily backup off so a
// full maintenance tick does not write one under the package directory.
func disableScheduledBackup(t testing.TB, database *db.DB) {
	t.Helper()
	mustExec(t, database, `UPDATE settings SET value = 'off' WHERE key = 'backup_schedule'`)
}

// requireCleanTick runs one maintenance tick and fails if any step failed.
func requireCleanTick(ctx context.Context, t testing.TB, m *maintenance) {
	t.Helper()
	if failed := m.tick(ctx); failed {
		t.Fatal("tick reported a failed step")
	}
}

// mustVoiceState reads userID's voice state and fails when there is none.
func mustVoiceState(ctx context.Context, t testing.TB, database *db.DB, userID int64) *db.VoiceState {
	t.Helper()
	state, err := database.GetVoiceState(ctx, userID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState(%d): state=%v err=%v", userID, state, err)
	}
	return state
}

// muteMemberViaTimeout issues a one-hour timeout against memberID by ownerID
// and server-mutes their current voice session on its behalf, as a real
// timeout does, returning the moderation action id.
func muteMemberViaTimeout(ctx context.Context, t testing.TB, database *db.DB, ownerID, memberID, chanID int64) int64 {
	t.Helper()
	state := mustVoiceState(ctx, t, database, memberID)
	actionID, _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "cool off", time.Now().Add(time.Hour))
	mustDo(t, "TimeoutUser", err)
	if matched, transitioned, err := database.MuteForTimeoutSession(ctx, memberID, chanID, actionID, state.JoinedAt, nil); err != nil || !matched || !transitioned {
		t.Fatalf("MuteForTimeoutSession: matched=%v transitioned=%v err=%v", matched, transitioned, err)
	}
	return actionID
}

// seedSessionToken creates an owner-role user and a live session for them,
// returning the bearer token a websocket client authenticates with.
func seedSessionToken(ctx context.Context, t testing.TB, database *db.DB, username string) string {
	t.Helper()
	userID, err := database.CreateUser(ctx, username, "hash", 1)
	mustDo(t, "CreateUser", err)
	token, err := auth.GenerateToken()
	mustDo(t, "GenerateToken", err)
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return token
}

// startTestHub builds a hub over database with the production reader and
// service wiring and runs it. The caller stops it, since some tests restart
// a hub mid-test.
func startTestHub(t testing.TB, database *db.DB, limiter *auth.RateLimiter) *ws.Hub {
	t.Helper()
	hub, err := ws.NewHub(ws.HubOptions{DB: database, Limiter: limiter, Settings: service.NewSettingsService(database), Readers: ws.DBReaders(database), Voice: service.NewVoiceService(database), Presence: service.NewUserService(database), Auth: service.NewSessionService(database)})
	mustDo(t, "ws.NewHub", err)
	go hub.Run()
	return hub
}

// resumeWithLastSeq connects a websocket client to hub, authenticates with
// token claiming lastSeq, and waits for the handshake response. The
// connection and server are torn down with the test.
func resumeWithLastSeq(ctx context.Context, t testing.TB, hub *ws.Hub, token string, lastSeq uint64) {
	t.Helper()
	srv := httptest.NewServer(ws.ServeWS(hub, []string{"*"}, 0))
	t.Cleanup(srv.Close)

	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	t.Cleanup(cancel)
	conn, dialResp, err := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if dialResp != nil && dialResp.Body != nil {
		_ = dialResp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })

	raw, _ := json.Marshal(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": token, "last_seq": lastSeq},
	})
	mustDo(t, "write auth", conn.Write(dialCtx, websocket.MessageText, raw))
	if _, _, err := conn.Read(dialCtx); err != nil {
		t.Fatalf("read handshake response: %v", err)
	}
}
