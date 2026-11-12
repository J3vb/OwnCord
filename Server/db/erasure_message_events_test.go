package db_test

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

func userMessageIDs(t *testing.T, database *db.DB, uid int64) []int64 {
	t.Helper()
	rows, err := database.QueryContext(context.Background(), `SELECT id FROM messages WHERE user_id = ? ORDER BY id`, uid)
	mustDo(t, "select messages", err)
	defer rows.Close() //nolint:errcheck
	var ids []int64
	for rows.Next() {
		var id int64
		mustDo(t, "scan", rows.Scan(&id))
		ids = append(ids, id)
	}
	mustDo(t, "rows", rows.Err())
	return ids
}

// seedMessageEvents writes an edit frame (no author on the wire) for each of the
// subject's messages and one for another user's message, and returns the other's
// frame count (seq of the first survivor).
func seedMessageEvents(t *testing.T, database *db.DB, sub eraseSubject, own []int64, otherMsg int64) {
	t.Helper()
	seq := 1000
	insert := func(payload string) {
		seq++
		_, err := database.ExecContext(context.Background(),
			`INSERT INTO events (seq, event_type, payload, channel_id) VALUES (?, 'x', ?, ?)`, seq, payload, sub.channel)
		mustDo(t, "seed event", err)
	}
	for _, id := range own {
		insert(fmt.Sprintf(`{"seq":%d,"type":"chat_edited","payload":{"id":%d,"content":"edited","edited_at":"t"}}`, seq+1, id))
		insert(fmt.Sprintf(`{"seq":%d,"type":"chat_edited","payload":{"message_id":%d,"kind":"x"}}`, seq+1, id))
	}
	insert(fmt.Sprintf(`{"seq":%d,"type":"chat_edited","payload":{"id":%d,"content":"theirs"}}`, seq+1, otherMsg))
	insert(fmt.Sprintf(`{"seq":%d,"type":"thread_changed","payload":{"thread":{"id":1,"owner_id":%d}}}`, seq+1, sub.other))
}

func countSeededEvents(t *testing.T, database *db.DB) int {
	t.Helper()
	var n int
	mustDo(t, "count", database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM events WHERE seq > 1000`).Scan(&n))
	return n
}

func otherMessageID(t *testing.T, database *db.DB, sub eraseSubject) int64 {
	t.Helper()
	var id int64
	mustDo(t, "other message", database.QueryRowContext(context.Background(),
		`SELECT id FROM messages WHERE user_id = ? ORDER BY id LIMIT 1`, sub.other).Scan(&id))
	return id
}

// An edit frame names its message and not its author, so the erasure matches it
// through the messages table; another user's edit and thread frames survive.
func TestEraseAccount_RemovesEditEventsOfErasedMessages(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	own := userMessageIDs(t, database, sub.id)
	if len(own) == 0 {
		t.Fatal("subject has no messages")
	}
	seedMessageEvents(t, database, sub, own, otherMessageID(t, database, sub))

	if _, err := database.EraseAccount(ctx, sub.id, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	if n := countSeededEvents(t, database); n != 2 {
		t.Errorf("seeded events left = %d, want the other user's edit and thread frames (2)", n)
	}
}

// A drain that stops after it has deleted some messages and is run again still
// leaves no edit frame for any of them, and reports every deleted id once.
func TestEraseAccountDrain_ResumedAfterCrashRemovesEditEvents(t *testing.T) {
	defer db.SetErasureChunkSizesForTest(1, 10)()
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	for i := range 3 {
		mustCreateMessageWithMentions(t, database, sub.channel, sub.id, fmt.Sprintf("extra %d", i), nil, nil, 0, false, nil)
	}
	own := userMessageIDs(t, database, sub.id)
	seedMessageEvents(t, database, sub, own, otherMessageID(t, database, sub))
	if _, err := database.EraseAccountLock(ctx, sub.id, true); err != nil {
		t.Fatalf("EraseAccountLock: %v", err)
	}

	crash := fmt.Errorf("simulated crash")
	db.SetErasureChunkHookForTest(database, func(stage string, _ int) error {
		if stage != "chunk" {
			return nil
		}
		if len(userMessageIDs(t, database, sub.id)) < len(own) {
			return crash
		}
		return nil
	})
	var seen []int64
	collect := func(ids []int64) { seen = append(seen, ids...) }
	if _, err := database.EraseAccountDrainWith(ctx, sub.id, time.Time{}, collect); err == nil {
		t.Fatal("first drain did not stop mid-messages")
	}
	if left := len(userMessageIDs(t, database, sub.id)); left == 0 || left == len(own) {
		t.Fatalf("messages left after the interrupted drain = %d of %d, want a partial drain", left, len(own))
	}
	db.SetErasureChunkHookForTest(database, nil)
	if done, err := database.EraseAccountDrainWith(ctx, sub.id, time.Time{}, collect); err != nil || !done {
		t.Fatalf("resumed drain = %v, %v", done, err)
	}
	if n := countSeededEvents(t, database); n != 2 {
		t.Errorf("seeded events left = %d, want 2 (the other user's)", n)
	}
	slices.Sort(seen)
	if fmt.Sprint(seen) != fmt.Sprint(own) {
		t.Errorf("drain reported messages %v, want %v", seen, own)
	}
}
