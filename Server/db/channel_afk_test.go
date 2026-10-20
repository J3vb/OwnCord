package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// TestMigration068_AFKUniqueIndex proves the database itself enforces "at most
// one AFK channel": a second flagged row is refused, the flag only accepts 0
// and 1, and a channel starts unflagged.
func TestMigration068_AFKUniqueIndex(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)

	a, err := database.CreateChannel(ctx, "afk-a", "voice", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	b, err := database.CreateChannel(ctx, "afk-b", "voice", "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if ch, err := database.GetChannel(ctx, a); err != nil || ch == nil || ch.AFK {
		t.Fatalf("a new channel must start unflagged: ch=%+v err=%v", ch, err)
	}

	if _, err := database.ExecContext(ctx, `UPDATE channels SET afk = 1 WHERE id = ?`, a); err != nil {
		t.Fatalf("first flag: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE channels SET afk = 1 WHERE id = ?`, b); err == nil {
		t.Fatal("a second afk = 1 row was accepted, want the unique index to refuse it")
	}
	if _, err := database.ExecContext(ctx, `UPDATE channels SET afk = 2 WHERE id = ?`, b); err == nil {
		t.Fatal("afk = 2 was accepted, want the CHECK constraint to refuse it")
	}
	// Any number of unflagged rows is fine.
	if _, err := database.ExecContext(ctx, `UPDATE channels SET afk = 0 WHERE id = ?`, a); err != nil {
		t.Fatalf("unflag: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE channels SET afk = 1 WHERE id = ?`, b); err != nil {
		t.Fatalf("flag after clear: %v", err)
	}
}

// SetAFKChannel clears the previous flag and sets the new one in one
// transaction, reports the channel it replaced, and a nil id clears.
func TestDBSetAFKChannel_SwapsAndReportsPrevious(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	a, _ := database.CreateChannel(ctx, "afk-a", "voice", "", "", 0)
	b, _ := database.CreateChannel(ctx, "afk-b", "voice", "", "", 1)

	prev, err := database.SetAFKChannel(ctx, &a)
	if err != nil || prev != nil {
		t.Fatalf("first set: prev=%v err=%v, want nil, nil", prev, err)
	}
	prev, err = database.SetAFKChannel(ctx, &b)
	if err != nil || prev == nil || *prev != a {
		t.Fatalf("switch: prev=%v err=%v, want %d", prev, err, a)
	}
	got, err := database.GetAFKChannel(ctx)
	if err != nil || got == nil || got.ID != b || !got.AFK {
		t.Fatalf("GetAFKChannel = %+v err=%v, want channel %d", got, err, b)
	}
	if ch, _ := database.GetChannel(ctx, a); ch == nil || ch.AFK {
		t.Fatalf("the previous channel kept its flag: %+v", ch)
	}
	prev, err = database.SetAFKChannel(ctx, nil)
	if err != nil || prev == nil || *prev != b {
		t.Fatalf("clear: prev=%v err=%v, want %d", prev, err, b)
	}
	if got, err := database.GetAFKChannel(ctx); err != nil || got != nil {
		t.Fatalf("after clear GetAFKChannel = %+v err=%v, want nil", got, err)
	}
}

// A target that was archived or deleted after the caller validated it commits
// nothing: the previous flag survives and ErrNotFound comes back.
func TestDBSetAFKChannel_GoneTargetKeepsPreviousFlag(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	a, _ := database.CreateChannel(ctx, "afk-a", "voice", "", "", 0)
	b, _ := database.CreateChannel(ctx, "afk-b", "voice", "", "", 1)
	if _, err := database.SetAFKChannel(ctx, &a); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE channels SET archived = 1 WHERE id = ?`, b); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{b, 9999} {
		if _, err := database.SetAFKChannel(ctx, &id); !errors.Is(err, db.ErrNotFound) {
			t.Fatalf("set %d: err=%v, want ErrNotFound", id, err)
		}
		if got, err := database.GetAFKChannel(ctx); err != nil || got == nil || got.ID != a {
			t.Fatalf("after failed set %d the previous flag must survive: got=%+v err=%v", id, got, err)
		}
	}
}

// Archiving the flagged channel clears the flag, so GetAFKChannel never hands
// back a hidden channel (trigger trg_channels_archive_clears_afk).
func TestMigration068_ArchivingClearsAFK(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	a, _ := database.CreateChannel(ctx, "afk-a", "voice", "", "", 0)
	if _, err := database.SetAFKChannel(ctx, &a); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE channels SET archived = 1 WHERE id = ?`, a); err != nil {
		t.Fatal(err)
	}
	if got, err := database.GetAFKChannel(ctx); err != nil || got != nil {
		t.Fatalf("an archived channel must not stay the AFK channel: got=%+v err=%v", got, err)
	}
}
