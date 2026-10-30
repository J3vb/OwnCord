package ws_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/ws"
)

// restartNotices reads conn in the background (a read timeout would close the
// socket) and delivers each server_restart delay it sees.
func restartNotices(ctx context.Context, conn *websocket.Conn) <-chan float64 {
	out := make(chan float64, 16)
	go func() {
		for {
			_, raw, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var m struct {
				Type    string `json:"type"`
				Payload struct {
					DelaySeconds float64 `json:"delay_seconds"`
				} `json:"payload"`
			}
			if json.Unmarshal(raw, &m) == nil && m.Type == "server_restart" {
				out <- m.Payload.DelaySeconds
			}
		}
	}()
	return out
}

func drainFor(ch <-chan float64, quiet time.Duration) []float64 {
	var got []float64
	for {
		select {
		case v := <-ch:
			got = append(got, v)
		case <-time.After(quiet):
			return got
		}
	}
}

// ARCH-045: an update sends the countdown from the admin handler and again
// from the graceful stop; a client must see one notice for the same reason
// inside the dedupe window, while a different reason or a cancel still goes out.
func TestBroadcastServerRestart_SameReasonWithinWindowIsSentOnce(t *testing.T) {
	t.Parallel()
	database := openServeTestDB(t)
	hub := newTestHubDeps(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	defer hub.Stop()

	userID, err := database.CreateUser(context.Background(), "ws-restart-dedupe", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	srv := httptest.NewServer(ws.ServeWS(hub, []string{"*"}, 0))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if resp != nil && resp.Body != nil {
		defer resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()
	raw, _ := json.Marshal(map[string]any{"type": "auth", "payload": map[string]string{"token": token}})
	_ = conn.Write(ctx, websocket.MessageText, raw)
	for range 2 {
		if _, _, err := conn.Read(ctx); err != nil {
			t.Fatalf("drain initial messages: %v", err)
		}
	}

	notices := restartNotices(ctx, conn)
	hub.BroadcastServerRestart(ws.RestartReasonUpdate, 5)
	hub.BroadcastServerRestart(ws.RestartReasonUpdate, 5)
	if got := drainFor(notices, 500*time.Millisecond); len(got) != 1 {
		t.Errorf("two same-reason notices inside the window delivered %v, want one", got)
	}

	hub.BroadcastServerRestart(ws.RestartReasonShutdown, 5)
	hub.BroadcastServerRestart(ws.RestartReasonShutdown, 0)
	if got := drainFor(notices, 500*time.Millisecond); len(got) != 2 {
		t.Errorf("a different reason plus a cancel delivered %v, want two", got)
	}

	// A cancel re-arms the gate: a retry right after it must announce again.
	hub.BroadcastServerRestart(ws.RestartReasonShutdown, 5)
	if got := drainFor(notices, 500*time.Millisecond); len(got) != 1 {
		t.Errorf("a retry after a cancel delivered %v, want one", got)
	}
}
