package db_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// seedAgedMessage inserts a message with an explicit UTC timestamp.
func seedAgedMessage(t *testing.T, database *db.DB, chID, uid int64, content string, at time.Time, pinned bool) int64 {
	t.Helper()
	p := 0
	if pinned {
		p = 1
	}
	res, err := database.ExecContext(context.Background(),
		`INSERT INTO messages (channel_id, user_id, content, timestamp, pinned) VALUES (?, ?, ?, ?, ?)`,
		chID, uid, content, at.UTC().Format("2006-01-02 15:04:05"), p)
	if err != nil {
		t.Fatalf("seed message: %v", err)
	}
	id, _ := res.LastInsertId()
	return id
}

func TestRetentionWindows_ServerAndChannelPrecedence(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	owner := seedUser(t, database, "ret-owner")
	general := seedChannel(t, database, "general-ret")
	forever := seedChannel(t, database, "forever-ret")
	shorter := seedChannel(t, database, "shorter-ret")
	other := seedUser(t, database, "ret-other")
	dm, _, err := database.GetOrCreateDMChannel(ctx, owner, other)
	if err != nil {
		t.Fatal(err)
	}

	// Fresh server: indefinite, no windows at all.
	if days, err := database.ServerRetentionDays(ctx); err != nil || days != 0 {
		t.Fatalf("default retention_days = %d, %v; want 0", days, err)
	}
	if ws, err := database.RetentionWindows(ctx); err != nil || len(ws) != 0 {
		t.Fatalf("windows with no policy = %v, %v; want none", ws, err)
	}
	// A channel override alone applies even without a server window.
	if err := database.SetChannelRetention(ctx, shorter, 3, owner); err != nil {
		t.Fatal(err)
	}
	ws, err := database.RetentionWindows(ctx)
	if err != nil || len(ws) != 1 || ws[0].ChannelID != shorter || ws[0].Days != 3 || ws[0].Source != "channel" {
		t.Fatalf("windows with one override = %+v, %v", ws, err)
	}
	// Server window 30: general inherits, forever opts out with 0, shorter
	// stays at 3, the DM is never listed.
	if err := database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "30"}); err != nil {
		t.Fatal(err)
	}
	if err := database.SetChannelRetention(ctx, forever, 0, owner); err != nil {
		t.Fatal(err)
	}
	ws, err = database.RetentionWindows(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := map[int64]db.RetentionWindow{}
	for _, w := range ws {
		got[w.ChannelID] = w
	}
	if w := got[general]; w.Days != 30 || w.Source != "server" {
		t.Errorf("general = %+v, want 30 days from the server", w)
	}
	if _, ok := got[forever]; ok {
		t.Errorf("a channel with a 0 override is listed: %+v", got[forever])
	}
	if w := got[shorter]; w.Days != 3 || w.Source != "channel" {
		t.Errorf("shorter = %+v, want 3 days from the channel", w)
	}
	if _, ok := got[dm.ID]; ok {
		t.Error("a DM channel has a retention window")
	}
	// A malformed setting keeps everything.
	if err := database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "soon"}); err != nil {
		t.Fatal(err)
	}
	if days, _ := database.ServerRetentionDays(ctx); days != 0 {
		t.Errorf("malformed retention_days = %d, want 0", days)
	}
	// Clearing the override.
	if removed, err := database.DeleteChannelRetention(ctx, shorter); err != nil || !removed {
		t.Fatalf("DeleteChannelRetention = %v, %v", removed, err)
	}
	if removed, _ := database.DeleteChannelRetention(ctx, shorter); removed {
		t.Error("a second delete reported a row")
	}
	if c, _ := database.GetChannelRetention(ctx, shorter); c != nil {
		t.Errorf("override still present: %+v", c)
	}
	if err := database.SetChannelRetention(ctx, shorter, -1, owner); err == nil {
		t.Error("negative days accepted")
	}
}

func TestSweepRetention_RemovesOnlyPastWindowUnpinned(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	alice := seedUser(t, database, "sweep-alice")
	bob := seedUser(t, database, "sweep-bob")
	ch := seedChannel(t, database, "sweep-chan")
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	cutoff := now.Add(-7 * 24 * time.Hour)
	old1 := seedAgedMessage(t, database, ch, alice, "old @bob needle-old", now.Add(-10*24*time.Hour), false)
	old2 := seedAgedMessage(t, database, ch, bob, "old too", now.Add(-8*24*time.Hour), false)
	atBoundary := seedAgedMessage(t, database, ch, alice, "exactly at the window", cutoff, false)
	pinned := seedAgedMessage(t, database, ch, alice, "pinned and old", now.Add(-30*24*time.Hour), true)
	fresh := seedAgedMessage(t, database, ch, alice, "fresh", now.Add(-time.Hour), false)
	reply := seedAgedMessage(t, database, ch, bob, "reply to old", now.Add(-time.Hour), false)
	if _, err := database.ExecContext(ctx, `UPDATE messages SET reply_to = ? WHERE id = ?`, old1, reply); err != nil {
		t.Fatal(err)
	}
	// A mention on old1 that bob has not read, and one on a fresh message.
	if _, err := database.ExecContext(ctx, `INSERT INTO message_mentions (message_id, mentioned_user_id) VALUES (?, ?)`, old1, bob); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES (?, ?, 0, 2)`, bob, ch); err != nil {
		t.Fatal(err)
	}
	for i, m := range []int64{old1, old2, fresh} {
		if _, err := database.ExecContext(ctx, `INSERT INTO attachments (id, message_id, filename, stored_as, mime_type, size, uploader_id) VALUES (?, ?, 'f', ?, 'image/png', 1, ?)`,
			fmt.Sprintf("att-%d", i), m, fmt.Sprintf("stored-%d", i), alice); err != nil {
			t.Fatal(err)
		}
	}
	if n, err := database.CountRetentionCandidates(ctx, ch, cutoff); err != nil || n != 2 {
		t.Fatalf("candidates = %d, %v; want 2 (the two past the window; pinned and at-boundary stay)", n, err)
	}

	// Bounded: one per call, then the rest.
	n, files, err := database.SweepRetention(ctx, ch, cutoff, 1)
	if err != nil || n != 1 || len(files) != 1 || files[0] != "stored-0" {
		t.Fatalf("first sweep = %d, %v, %v", n, files, err)
	}
	n, files, err = database.SweepRetention(ctx, ch, cutoff, 100)
	if err != nil || n != 1 || len(files) != 1 || files[0] != "stored-1" {
		t.Fatalf("second sweep = %d, %v, %v", n, files, err)
	}
	if n, _, err := database.SweepRetention(ctx, ch, cutoff, 100); err != nil || n != 0 {
		t.Fatalf("third sweep = %d, %v; want 0", n, err)
	}

	left := map[int64]bool{}
	rows, _ := database.QueryContext(ctx, `SELECT id FROM messages WHERE channel_id = ?`, ch)
	for rows.Next() {
		var id int64
		_ = rows.Scan(&id)
		left[id] = true
	}
	rows.Close()
	for _, want := range []int64{atBoundary, pinned, fresh, reply} {
		if !left[want] {
			t.Errorf("message %d was removed; it is at the boundary, pinned, fresh or a reply", want)
		}
	}
	for _, gone := range []int64{old1, old2} {
		if left[gone] {
			t.Errorf("message %d survived the sweep", gone)
		}
	}
	var replyTo *int64
	_ = database.QueryRowContext(ctx, `SELECT reply_to FROM messages WHERE id = ?`, reply).Scan(&replyTo)
	if replyTo != nil {
		t.Errorf("reply_to still points at a removed message")
	}
	var fts int
	_ = database.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'needle-old'`).Scan(&fts)
	if fts != 0 {
		t.Errorf("FTS still finds the removed text")
	}
	var atts int
	_ = database.QueryRowContext(ctx, `SELECT COUNT(*) FROM attachments`).Scan(&atts)
	if atts != 1 {
		t.Errorf("attachment rows left = %d, want 1 (the fresh message's)", atts)
	}
	if n, _ := database.GetMentionCount(ctx, bob, ch); n != 1 {
		t.Errorf("bob's mention_count = %d, want 1 (old1's mention reversed, the other kept)", n)
	}
}

func TestRetentionRuns_Journal(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	id, err := database.StartRetentionRun(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RecordRetentionRunFiles(ctx, id, 2, 7, []string{"a", "b"}); err != nil {
		t.Fatal(err)
	}
	runs, err := database.ListUnfinishedRetentionRuns(ctx)
	if err != nil || len(runs) != 1 || runs[0].ID != id || len(runs[0].Files) != 2 || runs[0].MessagesDeleted != 7 {
		t.Fatalf("unfinished = %+v, %v", runs, err)
	}
	if err := database.FinishRetentionRun(ctx, id, 1, "remove b: EIO"); err != nil {
		t.Fatal(err)
	}
	// Finished but a file short: still listed for the resume.
	runs, _ = database.ListUnfinishedRetentionRuns(ctx)
	if len(runs) != 1 || runs[0].LastError == "" {
		t.Fatalf("a short run is not listed for resume: %+v", runs)
	}
	if err := database.FinishRetentionRun(ctx, id, 2, ""); err != nil {
		t.Fatal(err)
	}
	if runs, _ := database.ListUnfinishedRetentionRuns(ctx); len(runs) != 0 {
		t.Fatalf("a complete run is still listed: %+v", runs)
	}
	run, err := database.GetRetentionRun(ctx, id)
	if err != nil || run.FilesRemoved != 2 || run.FinishedAt == nil || run.LastError != "" {
		t.Errorf("run = %+v, %v", run, err)
	}
	if _, err := database.GetRetentionRun(ctx, id+9); err == nil {
		t.Error("missing run found")
	}
	// A run with no files needs no resume once finished.
	empty, _ := database.StartRetentionRun(ctx)
	_ = database.RecordRetentionRunFiles(ctx, empty, 0, 0, nil)
	_ = database.FinishRetentionRun(ctx, empty, 0, "")
	if runs, _ := database.ListUnfinishedRetentionRuns(ctx); len(runs) != 0 {
		t.Fatalf("an empty finished run is listed: %+v", runs)
	}
}
