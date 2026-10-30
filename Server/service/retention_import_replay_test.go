package service

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// importedChannelFixture publishes an import of three 2020 messages and returns
// the channel, the hidden author and the message ids.
func importedChannelFixture(t *testing.T, database *db.DB) (ch, author int64, ids []int64) {
	t.Helper()
	ctx := context.Background()
	author, err := database.EnsureImportAccount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ch, job, err := database.StartImport(ctx, db.StartImportParams{Name: "history", SourceName: "e.json", DiscordChannelID: "1"})
	if err != nil {
		t.Fatal(err)
	}
	base := time.Date(2020, 1, 1, 12, 0, 0, 0, time.UTC)
	msgs := make([]db.ImportMessage, 0, 3)
	for i, k := range []string{"a", "b", "c"} {
		msgs = append(msgs, db.ImportMessage{Key: k, Content: "old " + k, Timestamp: base.Add(time.Duration(i) * time.Minute), DiscordUserID: "42", AuthorName: "Ann"})
	}
	byKey, err := database.ImportChunk(ctx, db.ImportChunkParams{
		JobID: job, ChannelID: ch, AuthorID: author, Messages: msgs, Progress: db.ImportProgress{Imported: 3},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.PublishImport(ctx, job, ch, byKey["c"], db.ImportProgress{Imported: 3}); err != nil {
		t.Fatal(err)
	}
	return ch, author, []int64{byKey["a"], byKey["b"], byKey["c"]}
}

// restoreImported puts the imported rows back the way a restored backup would
// hold them.
func restoreImported(t *testing.T, database *db.DB, ch, author int64, ids []int64) {
	t.Helper()
	ctx := context.Background()
	for i, id := range ids {
		if _, err := database.ExecContext(ctx,
			`INSERT OR IGNORE INTO messages (id, channel_id, user_id, content, timestamp) VALUES (?, ?, ?, 'old', ?)`,
			id, ch, author, time.Date(2020, 1, 1, 12, i, 0, 0, time.UTC).Format("2006-01-02 15:04:05")); err != nil {
			t.Fatal(err)
		}
		if _, err := database.ExecContext(ctx,
			`INSERT OR IGNORE INTO message_import_authors (message_id, discord_user_id, name) VALUES (?, '42', 'Ann')`, id); err != nil {
			t.Fatal(err)
		}
	}
}

// A sweep under the channel's own window deletes imported history. A backup
// from before that window existed brings the rows back, and the replay must
// delete them again even though the restored policy has no such window.
func TestRetention_ReplayRemovesImportedHistoryAChannelWindowSwept(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	owner, _ := database.CreateUser(ctx, "replay-owner", "hash", 1)
	ch, author, ids := importedChannelFixture(t, database)
	svc := newRetention(t, database, t.TempDir())
	if err := database.SetChannelRetention(ctx, ch, 365, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if n := countMessages(t, database, ch); n != 0 {
		t.Fatalf("channel window left %d imported messages", n)
	}

	// The restore: the override is not in the old backup, the rows are.
	if _, err := database.DeleteChannelRetention(ctx, ch); err != nil {
		t.Fatal(err)
	}
	restoreImported(t, database, ch, author, ids)
	if n := countMessages(t, database, ch); n != 3 {
		t.Fatalf("restore left %d messages, want 3", n)
	}
	n, err := svc.ReplayMarkers(ctx)
	if err != nil || n != 3 {
		t.Fatalf("ReplayMarkers = %d, %v; want the 3 imported messages removed again", n, err)
	}
}

// A marker written under the server-wide window never reached imported
// messages, so replaying it leaves them alone even if the policy now in the
// database has a window on the channel.
func TestRetention_ReplayOfAServerWindowMarkerSparesImportedHistory(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	owner, _ := database.CreateUser(ctx, "replay-owner2", "hash", 1)
	ch, _, _ := importedChannelFixture(t, database)
	svc := newRetention(t, database, t.TempDir())
	if err := database.SetSetting(ctx, db.RetentionDaysKey, "30"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := database.SetChannelRetention(ctx, ch, 365, owner); err != nil {
		t.Fatal(err)
	}
	if n, err := svc.ReplayMarkers(ctx); err != nil || n != 0 {
		t.Fatalf("ReplayMarkers = %d, %v; want nothing removed", n, err)
	}
	if n := countMessages(t, database, ch); n != 3 {
		t.Errorf("imported messages left = %d, want 3", n)
	}
}
