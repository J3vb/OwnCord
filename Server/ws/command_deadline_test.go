package ws_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── WP 4.1b: per-frame database deadline ────────────────────────────────────

// openFileDeadlineDB opens a migrated file-backed database, so the writer and
// reader pools are separate and a held writer does not block reads.
func openFileDeadlineDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(filepath.Join(t.TempDir(), "deadline.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return database
}

// deadlineClientMessageID builds a valid client_message_id: 13 digits of epoch
// milliseconds, a colon, and a v4 UUID.
func deadlineClientMessageID() string {
	return fmt.Sprintf("%d:%s", time.Now().UnixMilli(), "6f1c2a4e-8b3d-4f5a-9c7e-1d2b3a4c5e6f")
}

func deadlineChatSend(channelID int64, content, clientMsgID, reqID string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"id":   reqID,
		"payload": map[string]any{
			"channel_id":        channelID,
			"content":           content,
			"client_message_id": clientMsgID,
		},
	})
	return raw
}

// pinWriter holds the database's single writer connection inside a write
// transaction until the returned release is called.
func pinWriter(t *testing.T, database *db.DB) (release func()) {
	t.Helper()
	conn, err := database.SQLDb().Conn(context.Background())
	if err != nil {
		t.Fatalf("pin writer conn: %v", err)
	}
	if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		_ = conn.Close()
		t.Fatalf("BEGIN IMMEDIATE: %v", err)
	}
	var once sync.Once
	release = func() {
		once.Do(func() {
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
			_ = conn.Close()
		})
	}
	t.Cleanup(release)
	return release
}

func nextFrameOfType(ch <-chan []byte, typ string, within time.Duration) map[string]any {
	timer := time.NewTimer(within)
	defer timer.Stop()
	for {
		select {
		case raw := <-ch:
			var env map[string]any
			if json.Unmarshal(raw, &env) == nil && env["type"] == typ {
				return env
			}
		case <-timer.C:
			return nil
		}
	}
}

func countMessages(t *testing.T, database *db.DB, channelID int64) int {
	t.Helper()
	var n int
	row := database.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM messages WHERE channel_id = ?", channelID)
	if err := row.Scan(&n); err != nil && err != sql.ErrNoRows {
		t.Fatalf("count messages: %v", err)
	}
	return n
}

// Edge 1: a writer held past the deadline answers REQUEST_TIMEOUT with the
// request id and applies nothing; a retry with the same client_message_id
// after release is a fresh send, not a duplicate.
func TestHandleMessage_DeadlineSendsRequestTimeout(t *testing.T) {
	ws.SetCommandDeadlineForTest(t, 50*time.Millisecond)
	database := openFileDeadlineDB(t)
	limiter := auth.NewRateLimiter()
	hub := newTestHubDeps(t, database, limiter, service.New(database, limiter))
	go hub.Run()
	t.Cleanup(hub.Stop)

	user := seedOwnerUser(t, database, "deadline-owner")
	chID := seedTestChannel(t, database, "deadline-chan")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	release := pinWriter(t, database)
	cmid := deadlineClientMessageID()
	hub.HandleMessageForTest(c, deadlineChatSend(chID, "stalled", cmid, "req-stalled"))

	errFrame := nextFrameOfType(send, "error", time.Second)
	if errFrame == nil {
		t.Fatal("expected an error frame, got none")
	}
	if got := errFrame["id"]; got != "req-stalled" {
		t.Errorf("error id = %v, want req-stalled", got)
	}
	payload, _ := errFrame["payload"].(map[string]any)
	if got := payload["code"]; got != ws.ErrCodeRequestTimeout {
		t.Errorf("error code = %v, want %s", got, ws.ErrCodeRequestTimeout)
	}
	if f := nextFrameOfType(send, "chat_message", 100*time.Millisecond); f != nil {
		t.Errorf("chat_message was broadcast for a timed-out send: %v", f)
	}

	release()
	if n := countMessages(t, database, chID); n != 0 {
		t.Fatalf("messages after timeout = %d, want 0", n)
	}
	hub.HandleMessageForTest(c, deadlineChatSend(chID, "stalled", cmid, "req-retry"))
	ok := nextFrameOfType(send, "chat_send_ok", time.Second)
	if ok == nil {
		t.Fatal("retry got no chat_send_ok")
	}
	okPayload, _ := ok["payload"].(map[string]any)
	if dup, _ := okPayload["duplicate"].(bool); dup {
		t.Error("retry reported duplicate:true, but the timed-out send was not applied")
	}
	if n := countMessages(t, database, chID); n != 1 {
		t.Errorf("messages after retry = %d, want 1", n)
	}
}

// commitThenStallStore sleeps past the deadline right after a message commits,
// modelling a deadline that expires between Commit and the reply.
type commitThenStallStore struct {
	service.Store
	stall time.Duration
}

func (s commitThenStallStore) CreateMessageDelivery(ctx context.Context, p db.MessageDeliveryParams) (*db.MessageDelivery, error) {
	saved, err := s.Store.CreateMessageDelivery(ctx, p)
	time.Sleep(s.stall)
	return saved, err
}

// Edge 2: a deadline that expires after the commit still acknowledges and
// broadcasts, because the handler returned success.
func TestHandleMessage_DeadlineAfterCommitStillSucceeds(t *testing.T) {
	ws.SetCommandDeadlineForTest(t, 50*time.Millisecond)
	database := openFileDeadlineDB(t)
	limiter := auth.NewRateLimiter()
	st := commitThenStallStore{Store: database, stall: 150 * time.Millisecond}
	hub := newTestHubDeps(t, database, limiter, service.New(st, limiter))
	go hub.Run()
	t.Cleanup(hub.Stop)

	user := seedOwnerUser(t, database, "deadline-after")
	chID := seedTestChannel(t, database, "deadline-after-chan")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, deadlineChatSend(chID, "committed", deadlineClientMessageID(), "req-after"))

	if f := nextFrameOfType(send, "chat_send_ok", time.Second); f == nil {
		t.Fatal("expected chat_send_ok after a post-commit deadline, got none")
	}
	if n := countMessages(t, database, chID); n != 1 {
		t.Errorf("messages = %d, want 1", n)
	}
}

// Every registered type is either deadline-bound or exempt, with no stale
// exempt entries.
func TestCommandDeadline_EveryTypeClassified(t *testing.T) {
	hub, _ := newTestHub(t)
	registered := hub.RegisteredTypesForTest()
	exempt := ws.CommandDeadlineExemptTypesForTest()
	if len(exempt) == 0 {
		t.Fatal("exempt set is empty")
	}
	for _, typ := range exempt {
		if !slices.Contains(registered, typ) {
			t.Errorf("exempt entry %q is not a registered type", typ)
		}
	}
	want := []string{"voice_mod_mute", "voice_mod_deafen", "voice_mod_move", "voice_mod_kick", "chat_command"}
	slices.Sort(want)
	slices.Sort(exempt)
	if !slices.Equal(want, exempt) {
		t.Errorf("exempt set = %v, want %v", exempt, want)
	}
	bound := 0
	for _, typ := range registered {
		if !slices.Contains(exempt, typ) {
			bound++
		}
	}
	if bound == 0 {
		t.Error("no deadline-bound types")
	}
}

// Exempt types dispatch on the connection context (no deadline); a bound type
// gets one.
func TestHandleMessage_ExemptTypesHaveNoDeadline(t *testing.T) {
	ws.SetCommandDeadlineForTest(t, time.Minute)
	hub, database := newTestHub(t)
	user := seedOwnerUser(t, database, "deadline-exempt")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, 0, send)

	payloads := map[string]string{
		"voice_mod_mute":   `{"channel_id":1,"user_id":2,"muted":true}`,
		"voice_mod_deafen": `{"channel_id":1,"user_id":2,"deafened":true}`,
		"voice_mod_move":   `{"user_id":2,"to_channel_id":3}`,
		"voice_mod_kick":   `{"channel_id":1,"user_id":2}`,
		"chat_command":     `{"channel_id":1,"command":"x","args":[]}`,
		"ping":             `{}`,
	}
	for typ, payload := range payloads {
		var mu sync.Mutex
		var hasDeadline, called bool
		hub.ReplaceHandlerForTest(typ, func(ctx context.Context) ws.Result {
			mu.Lock()
			defer mu.Unlock()
			_, hasDeadline = ctx.Deadline()
			called = true
			return ws.Result{}
		})
		hub.HandleMessageForTest(c, []byte(`{"type":"`+typ+`","payload":`+payload+`}`))
		mu.Lock()
		gotCalled, gotDeadline := called, hasDeadline
		mu.Unlock()
		if !gotCalled {
			t.Errorf("%s: stub handler was not called", typ)
			continue
		}
		wantDeadline := typ == "ping"
		if gotDeadline != wantDeadline {
			t.Errorf("%s: ctx has deadline = %v, want %v", typ, gotDeadline, wantDeadline)
		}
	}
}
