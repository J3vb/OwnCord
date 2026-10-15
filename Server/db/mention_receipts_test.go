package db_test

import (
	"context"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// receiptMessageIDs returns the message ids the user holds a receipt for in a
// channel, ascending.
func receiptMessageIDs(t *testing.T, database *db.DB, userID, channelID int64) []int64 {
	t.Helper()
	rows, err := database.QueryContext(context.Background(),
		`SELECT message_id FROM mention_receipts WHERE user_id = ? AND channel_id = ? ORDER BY message_id`,
		userID, channelID)
	if err != nil {
		t.Fatalf("query mention_receipts: %v", err)
	}
	defer rows.Close() //nolint:errcheck // test read path
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	return ids
}

func TestMigration063_MentionReceiptsSchema(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	var pkCols []string
	rows, err := database.QueryContext(ctx, `SELECT name FROM pragma_table_info('mention_receipts') WHERE pk > 0 ORDER BY pk`)
	if err != nil {
		t.Fatalf("table_info: %v", err)
	}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatalf("scan: %v", err)
		}
		pkCols = append(pkCols, n)
	}
	rows.Close() //nolint:errcheck // test read path
	if want := []string{"user_id", "channel_id", "message_id"}; !slices.Equal(pkCols, want) {
		t.Errorf("primary key = %v, want %v", pkCols, want)
	}

	var idx int
	if err := database.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pragma_index_info('idx_mention_receipts_message') WHERE name = 'message_id'`).Scan(&idx); err != nil || idx != 1 {
		t.Errorf("idx_mention_receipts_message on message_id: count=%d err=%v", idx, err)
	}

	// Both cascades: a user delete and a message delete remove their receipts.
	alice := seedUser(t, database, "alice")
	bob := seedUser(t, database, "bob")
	ch := seedChannel(t, database, "general")
	m1, err := database.CreateMessage(ctx, ch, alice, "one", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	m2, err := database.CreateMessage(ctx, ch, alice, "two", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	for _, id := range []int64{m1, m2} {
		if _, err := database.ExecContext(ctx,
			`INSERT INTO mention_receipts (user_id, channel_id, message_id) VALUES (?, ?, ?)`, bob, ch, id); err != nil {
			t.Fatalf("insert receipt: %v", err)
		}
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO mention_receipts (user_id, channel_id, message_id) VALUES (?, ?, ?)`, bob, ch, m1); err == nil {
		t.Error("duplicate (user, channel, message) accepted, want primary key violation")
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM messages WHERE id = ?`, m1); err != nil {
		t.Fatalf("delete message: %v", err)
	}
	if got := receiptMessageIDs(t, database, bob, ch); !slices.Equal(got, []int64{m2}) {
		t.Errorf("after message delete receipts = %v, want [%d]", got, m2)
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, bob); err != nil {
		t.Fatalf("delete user: %v", err)
	}
	if got := receiptMessageIDs(t, database, bob, ch); len(got) != 0 {
		t.Errorf("after user delete receipts = %v, want none", got)
	}
}

func TestMigration063_BackfillOnlyBadgedRows(t *testing.T) {
	database := openMemory(t)
	if err := db.MigrateFS(database, migrationsBefore(t, "063")); err != nil {
		t.Fatalf("migrate to 062: %v", err)
	}
	ctx := context.Background()
	reader := seedUser(t, database, "reader")
	idle := seedUser(t, database, "idle")
	alice := seedUser(t, database, "alice")
	blocked := seedUser(t, database, "blocked")
	ch := seedChannel(t, database, "general")

	send := func(author int64, content string, mentions []int64, everyone bool) int64 {
		t.Helper()
		m, err := database.CreateMessageWithMentions(ctx, ch, author, content, nil, mentions, 0, everyone)
		if err != nil {
			t.Fatalf("CreateMessageWithMentions(%q): %v", content, err)
		}
		return m.ID
	}
	read := send(alice, "already read", []int64{reader}, false)
	direct := send(alice, "direct", []int64{reader}, false)
	everyone := send(alice, "everyone", nil, true)
	_ = send(reader, "own everyone", nil, true)
	_ = send(blocked, "from blocked", []int64{reader}, false)
	deleted := send(alice, "deleted", []int64{reader}, false)
	_ = send(alice, "no mention", nil, false)
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`UPDATE messages SET deleted = 1 WHERE id = ?`, []any{deleted}},
		{`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)`, []any{reader, blocked}},
		{`INSERT OR REPLACE INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES (?, ?, ?, 4)`, []any{reader, ch, read}},
		// A row at 0 shows no badge, so it gets nothing even with unread mentions.
		{`INSERT OR REPLACE INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES (?, ?, 0, 0)`, []any{idle, ch}},
	} {
		if _, err := database.ExecContext(ctx, q.sql, q.args...); err != nil {
			t.Fatalf("%s: %v", q.sql, err)
		}
	}

	if err := db.Migrate(database); err != nil {
		t.Fatalf("migrate to head: %v", err)
	}
	if got, want := receiptMessageIDs(t, database, reader, ch), []int64{direct, everyone}; !slices.Equal(got, want) {
		t.Errorf("reader receipts = %v, want %v (direct and @everyone after the pointer only)", got, want)
	}
	if got := receiptMessageIDs(t, database, idle, ch); len(got) != 0 {
		t.Errorf("zero-badge reader receipts = %v, want none", got)
	}
}

func TestIncrementMentionCountsBatch_ReceiptOnlyForAdmitted(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	author := seedUser(t, database, "author")
	fresh := seedUser(t, database, "fresh")
	guarded := seedUser(t, database, "guarded")
	ch := seedChannel(t, database, "general")
	live, err := database.CreateMessage(ctx, ch, author, "live", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	dead, err := database.CreateMessage(ctx, ch, author, "dead", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE messages SET deleted = 1 WHERE id = ?`, dead); err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	// guarded has already read past the live message.
	if _, err := database.ExecContext(ctx,
		`INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES (?, ?, ?, 0)`,
		guarded, ch, dead); err != nil {
		t.Fatalf("seed read state: %v", err)
	}

	bumped, err := database.IncrementMentionCountsBatch(ctx, ch, []db.MentionBatchEntry{
		{MsgID: live, UserIDs: []int64{fresh, guarded}},
		{MsgID: dead, UserIDs: []int64{fresh}},
	})
	if err != nil {
		t.Fatalf("IncrementMentionCountsBatch: %v", err)
	}
	if _, ok := bumped[guarded]; ok {
		t.Errorf("guarded reader was bumped: %v", bumped)
	}
	if got := receiptMessageIDs(t, database, fresh, ch); !slices.Equal(got, []int64{live}) {
		t.Errorf("fresh receipts = %v, want [%d] (the dead message gets none)", got, live)
	}
	if got := receiptMessageIDs(t, database, guarded, ch); len(got) != 0 {
		t.Errorf("guarded receipts = %v, want none", got)
	}
}

func TestMentionReceipts_CascadeOnMessageHardDelete(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	author := seedUser(t, database, "author")
	reader := seedUser(t, database, "reader")
	ch := seedChannel(t, database, "general")
	m, err := database.CreateMessageWithMentions(ctx, ch, author, "hi @reader", nil, []int64{reader}, 0, false)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	if err := database.IncrementMentionCounts(ctx, ch, m.ID, []int64{reader}); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}
	if got := receiptMessageIDs(t, database, reader, ch); !slices.Equal(got, []int64{m.ID}) {
		t.Fatalf("receipts before delete = %v, want [%d]", got, m.ID)
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM messages WHERE id = ?`, m.ID); err != nil {
		t.Fatalf("hard delete: %v", err)
	}
	if got := receiptMessageIDs(t, database, reader, ch); len(got) != 0 {
		t.Errorf("receipts after hard delete = %v, want none", got)
	}
}

func TestEraseAccount_RemovesRecipientReceipts(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	bystander := seedUser(t, database, "bystander")
	var msgs []int64
	rows, err := database.QueryContext(ctx, `SELECT id FROM messages WHERE channel_id = ? ORDER BY id`, sub.channel)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		msgs = append(msgs, id)
	}
	rows.Close() //nolint:errcheck // test read path
	for _, uid := range []int64{sub.id, bystander} {
		for _, id := range msgs {
			if _, err := database.ExecContext(ctx,
				`INSERT INTO mention_receipts (user_id, channel_id, message_id) VALUES (?, ?, ?)`, uid, sub.channel, id); err != nil {
				t.Fatalf("seed receipt: %v", err)
			}
		}
	}
	before, err := database.TakeInventory(ctx, sub.id, sub.username)
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	if before["11a mention receipts"] == 0 {
		t.Fatal("fixture holds no receipts for the subject")
	}
	if _, err := database.EraseAccount(ctx, sub.id, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	after, err := database.TakeInventory(ctx, sub.id, sub.username)
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	if after["11a mention receipts"] != 0 {
		t.Errorf("subject receipts after erasure = %d, want 0", after["11a mention receipts"])
	}
	// The subject's own message is gone, so its receipts went with it by cascade.
	var left int
	if err := database.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM mention_receipts WHERE message_id NOT IN (SELECT id FROM messages)`).Scan(&left); err != nil || left != 0 {
		t.Errorf("orphan receipts = %d err=%v, want 0", left, err)
	}
	if got := receiptMessageIDs(t, database, bystander, sub.channel); len(got) == 0 {
		t.Error("bystander lost every receipt, want those on surviving messages kept")
	}
}
