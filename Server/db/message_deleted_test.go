package db_test

import (
	"context"
	"testing"
)

// IsMessageDeleted reads the real messages table, so these tests use the
// package's full-migration opener (migrated_db_test.go) rather than the
// minimal shared testSchema fixture.
//
// The three answers are distinct on purpose: the attachment-access path that
// asks this treats "no row" as "no tombstone to enforce" and falls through to
// its own ACL, so found=false must never look like deleted=true.

func TestIsMessageDeleted_ReportsTheFlagAndTheRow(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	if _, err := database.ExecContext(ctx,
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'u1', '', 1)`); err != nil {
		t.Fatalf("seeding the user: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO channels (id, name, type, position) VALUES (10, 'general', 'text', 0)`); err != nil {
		t.Fatalf("seeding the channel: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO messages (id, channel_id, user_id, content, deleted) VALUES
		 (100, 10, 1, 'live', 0), (101, 10, 1, 'gone', 1)`); err != nil {
		t.Fatalf("seeding the messages: %v", err)
	}

	for _, tc := range []struct {
		name        string
		id          int64
		wantDeleted bool
		wantFound   bool
	}{
		{"a live message", 100, false, true},
		{"a soft-deleted message", 101, true, true},
		{"no row at all", 4242, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deleted, found, err := database.IsMessageDeleted(ctx, tc.id)
			if err != nil {
				t.Fatalf("IsMessageDeleted: %v", err)
			}
			if deleted != tc.wantDeleted || found != tc.wantFound {
				t.Errorf("IsMessageDeleted(%d) = (deleted=%v, found=%v), want (%v, %v)",
					tc.id, deleted, found, tc.wantDeleted, tc.wantFound)
			}
		})
	}
}

func TestIsMessageDeleted_SurfacesAQueryFailure(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	// Without the table the read cannot answer; that must be an error rather
	// than the "not deleted" any caller would otherwise serve the file on.
	if _, err := database.ExecContext(ctx, `DROP TABLE messages`); err != nil {
		t.Fatalf("dropping the table: %v", err)
	}

	deleted, found, err := database.IsMessageDeleted(ctx, 1)
	if err == nil {
		t.Fatalf("IsMessageDeleted returned (deleted=%v, found=%v, err=nil) with no messages table, want an error",
			deleted, found)
	}
	if deleted || found {
		t.Errorf("on error, got (deleted=%v, found=%v), want both false", deleted, found)
	}
}
