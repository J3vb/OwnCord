package db_test

import (
	"context"
	"errors"
	"maps"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// startTestImport creates a pending channel and a running job.
func startTestImport(t *testing.T, database *db.DB, name string) (channelID, jobID int64) {
	t.Helper()
	ch, job, err := database.StartImport(context.Background(), db.StartImportParams{
		Name: name, SourceName: "export.json", DiscordChannelID: "111",
	})
	if err != nil {
		t.Fatalf("StartImport: %v", err)
	}
	return ch, job
}

func importMessages(n int, prefix string) []db.ImportMessage {
	base := time.Date(2020, 1, 1, 12, 0, 0, 0, time.UTC)
	out := make([]db.ImportMessage, 0, n)
	for i := range n {
		out = append(out, db.ImportMessage{
			Key: prefix + string(rune('a'+i)), Content: "hello " + string(rune('a'+i)),
			Timestamp: base.Add(time.Duration(i) * time.Minute), DiscordUserID: "42", AuthorName: "Ann",
		})
	}
	return out
}

func TestEnsureImportAccount_IsOneRowAndNeverAMember(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	member := seedUser(t, database, "alice")

	id, err := database.EnsureImportAccount(ctx)
	if err != nil {
		t.Fatalf("EnsureImportAccount: %v", err)
	}
	again, err := database.EnsureImportAccount(ctx)
	if err != nil || again != id {
		t.Fatalf("second EnsureImportAccount = %d, %v; want %d", again, err, id)
	}
	if id == member {
		t.Fatal("import account reused a member row")
	}

	u, err := database.GetUserByID(ctx, id)
	if err != nil || u == nil {
		t.Fatalf("GetUserByID: %v %v", u, err)
	}
	if !u.IsSystemAccount() {
		t.Errorf("registration_status = %q, want system", u.RegistrationStatus)
	}
	if u.PasswordHash == "" || u.PasswordHash[0] != '!' {
		t.Errorf("password column %q is not an unusable marker", u.PasswordHash)
	}

	// A second system row is impossible.
	if _, err := database.ExecContext(ctx,
		`INSERT INTO users (username, password, role_id, registration_status) VALUES ('other', '!', 4, 'system')`); err == nil {
		t.Error("a second system account was accepted")
	}
}

func TestImportAccount_HiddenFromEveryListing(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	seedUser(t, database, "alice")
	importID, err := database.EnsureImportAccount(ctx)
	if err != nil {
		t.Fatal(err)
	}

	members, err := database.ListMembers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range members {
		if m.ID == importID {
			t.Error("ListMembers returned the import account")
		}
	}

	all, err := database.ListAllUsers(ctx, db.UserListFilter{}, 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range all {
		if u.ID == importID {
			t.Error("ListAllUsers returned the import account")
		}
	}

	if n, err := database.UserCount(ctx); err != nil || n != 1 {
		t.Errorf("UserCount = %d, %v; want 1 (the import account is not a member)", n, err)
	}
	stats, err := database.GetServerStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.UserCount != 1 {
		t.Errorf("stats user_count = %d, want 1", stats.UserCount)
	}

	counts, err := database.CountRoleMembers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if counts[4] != 1 {
		t.Errorf("Member role count = %d, want 1", counts[4])
	}

	if n, err := database.CountUsersWithoutTOTP(ctx); err != nil || n != 1 {
		t.Errorf("CountUsersWithoutTOTP = %d, %v; want 1", n, err)
	}
}

func TestImportAccount_NotMentionable(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	alice := seedUser(t, database, "alice")
	importID, err := database.EnsureImportAccount(ctx)
	if err != nil {
		t.Fatal(err)
	}

	byName, err := database.GetUserIDsByUsernames(ctx, []string{"alice", "[imported]"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := byName["[imported]"]; ok || byName["alice"] != alice {
		t.Errorf("GetUserIDsByUsernames = %v, want only alice", byName)
	}

	byID, err := database.ListMentionTargetsByUserIDs(ctx, []int64{alice, importID})
	if err != nil {
		t.Fatal(err)
	}
	if len(byID) != 1 || byID[0].UserID != alice {
		t.Errorf("ListMentionTargetsByUserIDs = %+v, want only alice", byID)
	}

	// @everyone and role mentions fan out by role: the account holds none.
	byRole, err := database.ListMentionTargetsByRoles(ctx, []int64{4})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range byRole {
		if m.UserID == importID {
			t.Error("a role mention reached the import account")
		}
	}
	held, err := database.GetMemberRoles(ctx, importID)
	if err != nil {
		t.Fatal(err)
	}
	if held != nil {
		t.Errorf("import account holds roles: %+v", held)
	}
}

func TestPendingChannel_HiddenFromClientReads(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	member := seedUser(t, database, "alice")
	visible := seedChannel(t, database, "general")
	pending, _ := startTestImport(t, database, "history")

	list, err := database.ListChannels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != visible {
		t.Errorf("ListChannels = %+v, want only the visible channel", list)
	}
	ch, err := database.GetChannel(ctx, pending)
	if err != nil || ch != nil {
		t.Errorf("GetChannel(pending) = %v, %v; want nil, nil", ch, err)
	}
	unread, err := database.GetChannelUnreadCounts(ctx, member)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := unread[pending]; ok {
		t.Error("GetChannelUnreadCounts lists the pending channel")
	}
	if _, ok := unread[visible]; !ok {
		t.Error("GetChannelUnreadCounts lost the visible channel")
	}
	if err := database.SetSetting(ctx, db.RetentionDaysKey, "30"); err != nil {
		t.Fatal(err)
	}
	windows, err := database.RetentionWindows(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(windows) != 1 {
		t.Errorf("retention windows = %+v, want only the visible channel", windows)
	}
	for _, w := range windows {
		if w.ChannelID == pending {
			t.Error("retention would reach the pending channel")
		}
	}
	stats, err := database.GetServerStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.ChannelCount != 1 {
		t.Errorf("stats channel_count = %d, want 1", stats.ChannelCount)
	}
}

func TestStartImport_SecondStartIsRefusedWhileRunning(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	ch, job := startTestImport(t, database, "one")

	_, _, err := database.StartImport(ctx, db.StartImportParams{Name: "two"})
	if !errors.Is(err, db.ErrImportRunning) {
		t.Fatalf("second StartImport err = %v, want ErrImportRunning", err)
	}
	// The refused start left nothing behind.
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM channels WHERE name = 'two'`).Scan(&n); err != nil || n != 0 {
		t.Errorf("refused start left %d channels (%v)", n, err)
	}

	if err := database.AbandonImport(ctx, job, ch, db.ImportCancelled, "stopped", db.ImportProgress{}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := database.StartImport(ctx, db.StartImportParams{Name: "two"}); err != nil {
		t.Errorf("StartImport after the first ended: %v", err)
	}
}

func TestImportChunk_MapsRepliesAndPublishMarksRead(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	member := seedUser(t, database, "alice")
	author, err := database.EnsureImportAccount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ch, job := startTestImport(t, database, "history")

	msgs := importMessages(3, "m")
	msgs[1].ReplyKey = "ma" // earlier in the same chunk
	msgs[2].ReplyKey = "zz" // not in the export: a plain message
	msgs[0].Pinned = true
	msgs[1].EditedAt = msgs[1].Timestamp.Add(time.Hour)
	ids, err := database.ImportChunk(ctx, db.ImportChunkParams{
		JobID: job, ChannelID: ch, AuthorID: author, Messages: msgs,
		Progress: db.ImportProgress{Total: 3, Imported: 3},
	})
	if err != nil {
		t.Fatal(err)
	}
	later, err := database.ImportChunk(ctx, db.ImportChunkParams{
		JobID: job, ChannelID: ch, AuthorID: author,
		Messages: []db.ImportMessage{{Key: "n", ReplyKey: "mc", Content: "later", Timestamp: msgs[2].Timestamp, DiscordUserID: "42", AuthorName: "Ann"}},
		KnownIDs: ids, Progress: db.ImportProgress{Total: 4, Imported: 4},
	})
	if err != nil {
		t.Fatal(err)
	}

	m1, _ := database.GetMessage(ctx, ids["mb"])
	if m1.ReplyTo == nil || *m1.ReplyTo != ids["ma"] {
		t.Errorf("reply inside a chunk not mapped: %+v", m1.ReplyTo)
	}
	if m1.EditedAt == nil || *m1.EditedAt != "2020-01-01 13:01:00" {
		t.Errorf("edited_at = %v", m1.EditedAt)
	}
	m2, _ := database.GetMessage(ctx, ids["mc"])
	if m2.ReplyTo != nil {
		t.Error("a reply to a message outside the export kept a link")
	}
	m0, _ := database.GetMessage(ctx, ids["ma"])
	if !m0.Pinned || m0.Timestamp != "2020-01-01 12:00:00" || m0.UserID != author || m0.Kind != 0 || m0.MentionsEveryone {
		t.Errorf("first message = %+v", m0)
	}
	m3, _ := database.GetMessage(ctx, later["n"])
	if m3.ReplyTo == nil || *m3.ReplyTo != ids["mc"] {
		t.Error("reply across chunks not mapped through KnownIDs")
	}
	var name string
	if err := database.QueryRowContext(ctx, `SELECT name FROM message_import_authors WHERE message_id = ?`, ids["ma"]).Scan(&name); err != nil || name != "Ann" {
		t.Errorf("author row = %q, %v", name, err)
	}
	var mentions int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM message_mentions`).Scan(&mentions); err != nil || mentions != 0 {
		t.Errorf("message_mentions rows = %d (%v)", mentions, err)
	}

	if err := database.PublishImport(ctx, job, ch, later["n"], db.ImportProgress{Total: 4, Imported: 4}); err != nil {
		t.Fatal(err)
	}
	got, err := database.GetChannel(ctx, ch)
	if err != nil || got == nil {
		t.Fatalf("published channel not visible: %v %v", got, err)
	}
	unread, err := database.GetChannelUnreadCounts(ctx, member)
	if err != nil {
		t.Fatal(err)
	}
	if u := unread[ch]; u.UnreadCount != 0 || u.MentionCount != 0 || u.LastReadMessageID != later["n"] {
		t.Errorf("unread after publish = %+v, want 0 unread past message %d", u, later["n"])
	}
	j, err := database.GetImportJob(ctx, job)
	if err != nil || j.Status != db.ImportDone || j.Imported != 4 || j.FinishedAt == nil {
		t.Errorf("job = %+v, %v", j, err)
	}
	var importRS int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM read_states WHERE user_id = ?`, author).Scan(&importRS); err != nil || importRS != 0 {
		t.Errorf("import account got %d read states", importRS)
	}
}

// Restart mid-import: the process dies after chunk 2 of 5. Nothing cleans up
// on the way down, so the boot clean-up has to remove the channel, its messages
// and the attachment links, and fail the job.
func TestFailInterruptedImports_RestartAfterChunkTwoOfFive(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	author, err := database.EnsureImportAccount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ch, job := startTestImport(t, database, "history")

	known := map[string]int64{}
	for chunk := range 2 {
		prefix := string(rune('A' + chunk))
		msgs := importMessages(2, prefix)
		attID := "att-" + prefix
		if err := database.CreateAttachment(ctx, attID, author, "pic.txt", "stored-"+prefix, "text/plain", 3, nil, nil); err != nil {
			t.Fatal(err)
		}
		msgs[0].AttachmentIDs = []string{attID}
		ids, err := database.ImportChunk(ctx, db.ImportChunkParams{
			JobID: job, ChannelID: ch, AuthorID: author, Messages: msgs, KnownIDs: known,
			Progress: db.ImportProgress{Total: 10, Imported: int64((chunk + 1) * 2)},
		})
		if err != nil {
			t.Fatal(err)
		}
		maps.Copy(known, ids)
	}
	// A file stored for chunk 3 whose rows never landed.
	if err := database.CreateAttachment(ctx, "att-C", author, "pic.txt", "stored-C", "text/plain", 3, nil, nil); err != nil {
		t.Fatal(err)
	}

	// The process "restarts": boot runs the clean-up.
	failed, err := database.FailInterruptedImports(ctx)
	if err != nil || failed != 1 {
		t.Fatalf("FailInterruptedImports = %d, %v; want 1", failed, err)
	}

	for _, q := range []struct{ what, sql string }{
		{"channels", `SELECT COUNT(*) FROM channels WHERE id = ` + itoa(ch)},
		{"messages", `SELECT COUNT(*) FROM messages WHERE channel_id = ` + itoa(ch)},
		{"author rows", `SELECT COUNT(*) FROM message_import_authors`},
		{"linked attachments", `SELECT COUNT(*) FROM attachments WHERE message_id IS NOT NULL`},
	} {
		var n int
		if err := database.QueryRowContext(ctx, q.sql).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s left after clean-up: %d (%v)", q.what, n, err)
		}
	}
	j, err := database.GetImportJob(ctx, job)
	if err != nil {
		t.Fatal(err)
	}
	if j.Status != db.ImportFailed || j.Error == nil || *j.Error != db.ImportInterruptedMessage || j.FinishedAt == nil {
		t.Errorf("job after restart = %+v", j)
	}
	if j.ChannelID != nil {
		t.Errorf("job still names the deleted channel %d", *j.ChannelID)
	}
	if list, _ := database.ListChannels(ctx); len(list) != 0 {
		t.Errorf("channels visible after restart: %+v", list)
	}

	// The files are reclaimed by the orphan sweep: every attachment is now
	// unlinked, so a sweep past their grace period takes all three.
	files, err := database.DeleteOrphanedAttachments(ctx, time.Now().Add(48*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 3 {
		t.Errorf("orphan sweep reclaimed %v, want the 3 stored files", files)
	}

	// And a second import can start.
	if _, _, err := database.StartImport(ctx, db.StartImportParams{Name: "again"}); err != nil {
		t.Errorf("StartImport after restart: %v", err)
	}
}

func TestFailInterruptedImports_LeavesPublishedChannelAlone(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	author, _ := database.EnsureImportAccount(ctx)
	ch, job := startTestImport(t, database, "history")
	ids, err := database.ImportChunk(ctx, db.ImportChunkParams{
		JobID: job, ChannelID: ch, AuthorID: author, Messages: importMessages(1, "m"),
		Progress: db.ImportProgress{Imported: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.PublishImport(ctx, job, ch, ids["ma"], db.ImportProgress{Imported: 1}); err != nil {
		t.Fatal(err)
	}
	if n, err := database.FailInterruptedImports(ctx); err != nil || n != 0 {
		t.Fatalf("FailInterruptedImports = %d, %v", n, err)
	}
	if got, _ := database.GetChannel(ctx, ch); got == nil {
		t.Error("clean-up deleted a published channel")
	}
	// A late abandon of a finished job changes nothing either.
	if err := database.AbandonImport(ctx, job, ch, db.ImportFailed, "late", db.ImportProgress{}); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("late AbandonImport err = %v, want ErrNotFound", err)
	}
	if got, _ := database.GetChannel(ctx, ch); got == nil {
		t.Error("late abandon deleted a published channel")
	}
}

func TestStartImport_UnknownCategoryWritesNothing(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	_, _, err := database.StartImport(ctx, db.StartImportParams{Name: "x", CategoryID: 999})
	if !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	var n int
	_ = database.QueryRowContext(ctx, `SELECT COUNT(*) FROM import_jobs`).Scan(&n)
	if n != 0 {
		t.Errorf("import_jobs rows = %d", n)
	}
}

// First-run setup is gated on there being no users. The hidden account must not
// make a server that has not been set up look set up.
func TestImportAccount_DoesNotCountAsAUserForSetup(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	if _, err := database.EnsureImportAccount(ctx); err != nil {
		t.Fatal(err)
	}
	if n, err := database.UserCount(ctx); err != nil || n != 0 {
		t.Errorf("UserCount = %d, %v; want 0", n, err)
	}
}
