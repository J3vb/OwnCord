package ws_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// The O1 A4 window (docs/architecture/data-lifecycle.md): a socket
// authenticated before the erasure keeps sending after it. Whether or not
// the member_ban broadcast has cut it yet, no message of the erased user
// survives — after the transaction the users row is gone and the message
// insert fails its foreign key; after the broadcast the frame is dropped.
func TestErasure_MessageOnAuthenticatedSocketDoesNotSurvive(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHubWith(t, ws.HubOptions{DB: database, Limiter: limiter, Services: svc})
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })

	ctx := context.Background()
	if _, err := database.CreateUser(ctx, "erasure-other-owner", "hash", 1); err != nil {
		t.Fatal(err)
	}
	subject := seedCoverageOwner(t, database, "erasure-subject")
	chID := seedTestChannel(t, database, "erasure-chan")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, subject, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	chat := func(content string) []byte {
		raw, _ := json.Marshal(map[string]any{
			"type":    "chat_send",
			"payload": map[string]any{"channel_id": chID, "content": content},
		})
		return raw
	}
	// The socket works before the erasure.
	hub.HandleMessageForTest(c, chat("before"))
	waitFor(t, waitTimeout, func() bool { return countMessagesBy(t, database, subject.ID) == 1 }, "the pre-erasure message to land")

	if err := svc.Erasure.Erase(ctx, subject.ID); err != nil {
		t.Fatalf("Erase: %v", err)
	}
	if n := countMessagesBy(t, database, subject.ID); n != 0 {
		t.Fatalf("messages by the subject after the erasure = %d, want 0", n)
	}

	// Between commit and broadcast: the socket is still registered.
	hub.HandleMessageForTest(c, chat("after commit, before the kick"))
	if code := drainForErrorCode(send, 500*time.Millisecond); code == "" {
		t.Errorf("a message sent after the erasure was accepted silently")
	}
	if n := countMessagesBy(t, database, subject.ID); n != 0 {
		t.Errorf("a message landed after the erasure: %d rows", n)
	}

	// After the broadcast: the socket is cut and frames are dropped.
	hub.BroadcastMemberBan(subject.ID)
	hub.HandleMessageForTest(c, chat("after the kick"))
	if n := countMessagesBy(t, database, subject.ID); n != 0 {
		t.Errorf("a message landed after the kick: %d rows", n)
	}
	if n := countMessagesBy(t, database, 0); n != 0 {
		t.Errorf("%d messages exist with no author", n)
	}
}

func countMessagesBy(t *testing.T, database *db.DB, uid int64) int {
	t.Helper()
	var n int
	q := `SELECT COUNT(*) FROM messages WHERE user_id = ?`
	if uid == 0 {
		q = `SELECT COUNT(*) FROM messages WHERE user_id NOT IN (SELECT id FROM users)`
	}
	if err := database.QueryRowContext(context.Background(), q, uid).Scan(&n); err != nil {
		t.Fatalf("count messages: %v", err)
	}
	return n
}
