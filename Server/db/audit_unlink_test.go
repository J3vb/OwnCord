package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// Flush is the erasure's barrier and Unlink its rule (B4-10): an entry
// about the subject queued before the erasure transaction is written under
// the rule — id 0, detail cleared, the deletion marker's token in place —
// and so is one enqueued after it; Relink withdraws the rule for a refused
// erasure. The timer is an hour away, so the barrier is the only flush.
func TestAuditWriter_FlushBarrierWritesQueuedEntriesUnlinked(t *testing.T) {
	ctx := context.Background()
	store := &fakeAuditStore{}
	w := db.NewAuditWriter(store, 64, 50, time.Hour)
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("Flush before Start: %v", err)
	}
	w.Start(ctx)
	defer w.Stop(ctx)

	w.Enqueue(7, "role_change", "user", 42, "member → moderator")
	w.Enqueue(42, "message_delete", "message", 9, "by the subject")
	w.Enqueue(7, "role_change", "user", 8, "someone else")
	if _, entries := store.snapshot(); len(entries) != 0 {
		t.Fatalf("entries persisted before the barrier: %+v", entries)
	}
	w.Unlink(42, "tok-42")
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	flushes, entries := store.snapshot()
	if flushes != 1 || len(entries) != 3 {
		t.Fatalf("after the barrier: %d flushes, %d entries; want 1 and 3", flushes, len(entries))
	}
	if e := entries[0]; e.ActorID != 7 || e.TargetID != 0 || e.Detail != "" || e.SubjectToken != "tok-42" {
		t.Errorf("entry naming the subject as target = %+v, want target 0, no detail, the token", e)
	}
	if e := entries[1]; e.ActorID != 0 || e.TargetID != 9 || e.Detail != "" || e.SubjectToken != "tok-42" {
		t.Errorf("entry naming the subject as actor = %+v, want actor 0, no detail, the token", e)
	}
	if e := entries[2]; e.ActorID != 7 || e.TargetID != 8 || e.Detail != "someone else" || e.SubjectToken != "" {
		t.Errorf("entry about someone else = %+v, want untouched", e)
	}

	// A message target with the subject's numeric id is not a user: left alone.
	w.Enqueue(7, "message_delete", "message", 42, "message 42")
	// A late entry, after the barrier: the rule outlives it.
	w.Enqueue(42, "user_login", "user", 42, "203.0.113.9")
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("second Flush: %v", err)
	}
	_, entries = store.snapshot()
	if len(entries) != 5 {
		t.Fatalf("entries after the second barrier = %d, want 5", len(entries))
	}
	if e := entries[3]; e.TargetID != 42 || e.Detail != "message 42" {
		t.Errorf("message-target entry = %+v, want untouched", e)
	}
	if e := entries[4]; e.ActorID != 0 || e.TargetID != 0 || e.Detail != "" || e.SubjectToken != "tok-42" {
		t.Errorf("late entry = %+v, want unlinked", e)
	}

	// Relink: the refused erasure's rule is withdrawn.
	w.Relink(42)
	w.Enqueue(42, "user_login", "user", 42, "203.0.113.9")
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("third Flush: %v", err)
	}
	_, entries = store.snapshot()
	if e := entries[len(entries)-1]; e.ActorID != 42 || e.TargetID != 42 || e.Detail != "203.0.113.9" || e.SubjectToken != "" {
		t.Errorf("entry after Relink = %+v, want its ids back", e)
	}

	// A cancelled barrier reports it and leaves the writer running.
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := w.Flush(cancelled); err == nil {
		t.Error("Flush with a cancelled context returned nil")
	}
	var nilWriter *db.AuditWriter
	nilWriter.Unlink(1, "x")
	nilWriter.Relink(1)
	if err := nilWriter.Flush(ctx); err != nil {
		t.Errorf("nil writer Flush = %v", err)
	}
}
