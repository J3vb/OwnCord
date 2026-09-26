package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// Flush is the erasure's barrier: everything enqueued before it is handed
// to the store when it returns, as it was queued, with the timer an hour
// away; a writer that never started, or a cancelled barrier, reports so
// without touching the queue.
func TestAuditWriter_FlushIsABarrier(t *testing.T) {
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
	if _, entries := store.snapshot(); len(entries) != 0 {
		t.Fatalf("entries persisted before the barrier: %+v", entries)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	flushes, entries := store.snapshot()
	if flushes != 1 || len(entries) != 2 {
		t.Fatalf("after the barrier: %d flushes, %d entries; want 1 and 2", flushes, len(entries))
	}
	// As queued: the unlinking rule belongs to the store's insert, not to
	// the writer (TestPersistAudits_AppliesTheUnlinkRulesAtInsert).
	if e := entries[0]; e.ActorID != 7 || e.TargetID != 42 || e.Detail != "member → moderator" || e.SubjectToken != "" || e.ActorToken != "" {
		t.Errorf("entry after the barrier = %+v, want it as queued", e)
	}
	w.Enqueue(1, "settings_change", "settings", 0, "retention")
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("second Flush: %v", err)
	}
	if _, entries := store.snapshot(); len(entries) != 3 {
		t.Errorf("entries after the second barrier = %d, want 3", len(entries))
	}

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := w.Flush(cancelled); err == nil {
		t.Error("Flush with a cancelled context returned nil")
	}
	var nilWriter *db.AuditWriter
	nilWriter.Unlink(1, "x")
	if err := nilWriter.Flush(ctx); err != nil {
		t.Errorf("nil writer Flush = %v", err)
	}
}

// The unlinking rule (AuditWriter.Unlink) is applied by the store at insert
// time, under the writer connection: an entry about the subject that the
// batch path or the single-row path writes once the rule exists goes down
// unlinked — the actor side to actor_token, the target side to
// subject_token, both on an entry naming two erased subjects — while an
// entry about anyone else, or a message target with a colliding id, is
// untouched; without a writer the store writes as told.
func TestPersistAudits_AppliesTheUnlinkRulesAtInsert(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	w := db.NewAuditWriter(database, 64, 50, time.Hour)
	database.SetAuditWriter(w)
	w.Unlink(42, "tok-42")
	w.Unlink(8, "tok-8")
	entries := []db.AuditEntry{
		{ActorID: 7, Action: "role_change", TargetType: "user", TargetID: 42, Detail: "member → moderator"},
		{ActorID: 42, Action: "message_delete", TargetType: "message", TargetID: 9, Detail: "by the subject"},
		{ActorID: 42, Action: "user_ban", TargetType: "user", TargetID: 8, Detail: "spam"},
		{ActorID: 7, Action: "message_pin", TargetType: "message", TargetID: 42, Detail: "message 42"},
		{ActorID: 7, Action: "role_create", TargetType: "role", TargetID: 3, Detail: "someone else"},
	}
	if n, err := database.PersistAudits(ctx, entries); err != nil || n != 5 {
		t.Fatalf("PersistAudits = %d, %v", n, err)
	}
	if err := database.LogAuditEntry(ctx, db.AuditEntry{ActorID: 42, Action: "user_login", TargetType: "user", TargetID: 42, Detail: "203.0.113.9"}); err != nil {
		t.Fatal(err)
	}
	database.SetAuditWriter(nil)
	if err := database.LogAuditEntry(ctx, db.AuditEntry{ActorID: 42, Action: "user_logout", TargetType: "user", TargetID: 42, Detail: "bye"}); err != nil {
		t.Fatal(err)
	}
	got, err := database.GetAuditLog(ctx, 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	byAction := map[string]db.AuditEntry{}
	for _, e := range got {
		byAction[e.Action] = e
	}
	check := func(action string, actor, target int64, detail, actorTok, subjectTok string) {
		t.Helper()
		e, ok := byAction[action]
		if !ok {
			t.Errorf("%s: no row", action)
			return
		}
		if e.ActorID != actor || e.TargetID != target || e.Detail != detail || e.ActorToken != actorTok || e.SubjectToken != subjectTok {
			t.Errorf("%s = actor %d target %d detail %q actor token %q subject token %q; want %d %d %q %q %q",
				action, e.ActorID, e.TargetID, e.Detail, e.ActorToken, e.SubjectToken, actor, target, detail, actorTok, subjectTok)
		}
	}
	check("role_change", 7, 0, "", "", "tok-42")
	check("message_delete", 0, 9, "", "tok-42", "")
	check("user_ban", 0, 0, "", "tok-42", "tok-8")
	check("message_pin", 7, 42, "message 42", "", "")
	check("role_create", 7, 3, "someone else", "", "")
	check("user_login", 0, 0, "", "tok-42", "tok-42")
	check("user_logout", 42, 42, "bye", "", "")
}
