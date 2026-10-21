package db

import (
	"context"
	"errors"
	"testing"
	"time"
)

// threadWonBy is the unique-index backstop of CreateThread: it names the thread
// that took the starter, or fails when there is none to name.
func TestThreadWonBy_NamesTheWinner(t *testing.T) {
	d := openMigratedMemoryInternal(t)
	ctx := context.Background()
	u, err := d.CreateUser(ctx, "winner", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	parent, err := d.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	starter, err := d.CreateMessage(ctx, parent, u, "start", nil)
	if err != nil {
		t.Fatal(err)
	}

	if err := threadWonBy(ctx, d.q, starter); err == nil || errors.Is(err, ErrThreadExists) {
		t.Fatalf("no thread yet: err = %v, want a lookup failure", err)
	}
	th, _, err := d.CreateThread(ctx, NewThread{ParentID: parent, StarterMessageID: starter, OwnerID: u, Name: "t", AutoArchiveMinutes: 60})
	if err != nil {
		t.Fatal(err)
	}
	var exists *ThreadExistsError
	err = threadWonBy(ctx, d.q, starter)
	if !errors.Is(err, ErrThreadExists) || !errors.As(err, &exists) || exists.ThreadID != th.ID {
		t.Fatalf("err = %v, want ThreadExistsError naming %d", err, th.ID)
	}
}

// A committed message in a thread records activity and reopens it; any other
// channel is untouched, and a failing lookup is reported.
func TestTouchThreadOnPost(t *testing.T) {
	d := openMigratedMemoryInternal(t)
	ctx := context.Background()
	u, err := d.CreateUser(ctx, "poster", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	parent, err := d.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	starter, err := d.CreateMessage(ctx, parent, u, "start", nil)
	if err != nil {
		t.Fatal(err)
	}
	th, _, err := d.CreateThread(ctx, NewThread{ParentID: parent, StarterMessageID: starter, OwnerID: u, Name: "t", AutoArchiveMinutes: 60})
	if err != nil {
		t.Fatal(err)
	}
	old := "2020-01-01T00:00:00Z"
	if _, err := d.ExecContext(ctx, `UPDATE channels SET thread_archived = 1, thread_last_activity_at = ? WHERE id = ?`, old, th.ID); err != nil {
		t.Fatal(err)
	}

	if err := touchThreadOnPost(ctx, d.q, parent); err != nil {
		t.Fatalf("ordinary channel: %v", err)
	}
	if err := touchThreadOnPost(ctx, d.q, th.ID); err != nil {
		t.Fatalf("thread: %v", err)
	}
	got, err := d.GetThread(ctx, th.ID)
	if err != nil || got == nil || got.Archived {
		t.Fatalf("thread after a post = %+v, %v, want reopened", got, err)
	}
	var act string
	if err := d.QueryRowContext(ctx, `SELECT thread_last_activity_at FROM channels WHERE id = ?`, th.ID).Scan(&act); err != nil || act <= old {
		t.Errorf("activity = %q, %v, want a fresh time", act, err)
	}

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := touchThreadOnPost(cancelled, d.q, th.ID); err == nil {
		t.Error("a failing lookup was swallowed")
	}
}

// The delivery path (what chat_send uses) touches the thread in the message's
// own transaction.
func TestCreateMessageDelivery_TouchesThread(t *testing.T) {
	d := openMigratedMemoryInternal(t)
	ctx := context.Background()
	u, err := d.CreateUser(ctx, "sender", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	parent, err := d.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	starter, err := d.CreateMessage(ctx, parent, u, "start", nil)
	if err != nil {
		t.Fatal(err)
	}
	th, _, err := d.CreateThread(ctx, NewThread{ParentID: parent, StarterMessageID: starter, OwnerID: u, Name: "t", AutoArchiveMinutes: 60})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.ExecContext(ctx, `UPDATE channels SET thread_archived = 1 WHERE id = ?`, th.ID); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	res, err := d.CreateMessageDelivery(ctx, MessageDeliveryParams{
		UserID: u, ChannelID: th.ID, ClientMessageID: "c1", PayloadHash: []byte("h"),
		ExpiresAtMS: now + 60_000, CreatedAtMS: now, Content: "reply",
	})
	if err != nil || res == nil {
		t.Fatalf("CreateMessageDelivery = %+v, %v", res, err)
	}
	got, err := d.GetThread(ctx, th.ID)
	if err != nil || got == nil || got.Archived || got.MessageCount != 1 {
		t.Errorf("thread after a delivery = %+v, %v, want reopened with one message", got, err)
	}
}
