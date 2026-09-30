package ws

// P5-S02: a restart reconnects every client at once, and that herd must cost
// no bcrypt. The resume authenticates with the stored session token (a hash
// lookup), never a password, so it needs no slot of the admission budget that
// every bcrypt site takes (B4-4). This pins that: with the budget fully held,
// a post-restart resume still gets auth_ok. A change that put password
// re-authentication on the resume path would queue behind the held slot and
// fail here.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestResumeAfterRestartTakesNoAdmissionSlot(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "restart-token-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	limiter := auth.NewRateLimiter()
	limiter.SetAdmissionBudget(1)
	release, ok := limiter.Admission().TryAcquire()
	if !ok {
		t.Fatal("could not take the budget's only slot")
	}
	defer release()

	hub := newTestHub(t, database, limiter, nil)
	go hub.Run()
	defer hub.Stop()
	// The post-restart boot (see restart_resync_active_channel_test.go).
	hub.SeedSeq(1_000_000_000)
	hub.MarkVisibilityChanged()

	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	defer srv.Close()

	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, dialResp, err := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if dialResp != nil && dialResp.Body != nil {
		_ = dialResp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	raw, _ := json.Marshal(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": token, "last_seq": 500},
	})
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	_, msg, err := conn.Read(dialCtx)
	if err != nil {
		t.Fatalf("read auth reply: %v", err)
	}
	var reply map[string]any
	if err := json.Unmarshal(msg, &reply); err != nil {
		t.Fatalf("unmarshal auth reply: %v", err)
	}
	if reply["type"] != MsgTypeAuthOK {
		t.Fatalf("post-restart resume with the admission budget held: got %s, want auth_ok", msg)
	}
	if got := limiter.Admission().Peak(); got != 1 {
		t.Fatalf("admission peak = %d, want 1 (only the held slot): the resume took a slot", got)
	}
}
