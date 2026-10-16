package db_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// rpFixture is a channel with n messages from one author and one reader.
type rpFixture struct {
	database *db.DB
	reader   int64
	author   int64
	ch       int64
	msgs     []int64
}

func newRPFixture(t *testing.T, n int) *rpFixture {
	t.Helper()
	database := openMigratedMemory(t)
	f := &rpFixture{
		database: database,
		reader:   seedUser(t, database, "rp-reader"),
		author:   seedUser(t, database, "rp-author"),
		ch:       seedChannel(t, database, "rp-ch"),
	}
	for range n {
		f.msgs = append(f.msgs, f.newMessage(t))
	}
	return f
}

func (f *rpFixture) newMessage(t *testing.T) int64 {
	t.Helper()
	id, err := f.database.CreateMessage(context.Background(), f.ch, f.author, "m", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	return id
}

// mention raises the reader's badge for msgID the way the worker does: a
// counter bump plus its receipt.
func (f *rpFixture) mention(t *testing.T, msgID int64) {
	t.Helper()
	if _, err := f.database.IncrementMentionCountsBatch(context.Background(), f.ch,
		[]db.MentionBatchEntry{{MsgID: msgID, UserIDs: []int64{f.reader}}}); err != nil {
		t.Fatalf("IncrementMentionCountsBatch: %v", err)
	}
}

func (f *rpFixture) move(t *testing.T, op db.ReadPointerOp, msgID int64) db.ReadPointer {
	t.Helper()
	rs, err := f.database.MoveReadPointer(context.Background(), f.reader, f.ch, op, msgID)
	if err != nil {
		t.Fatalf("MoveReadPointer(op=%d, msg=%d): %v", op, msgID, err)
	}
	return rs
}

func (f *rpFixture) row(t *testing.T) (ptr, count int64, found bool) {
	t.Helper()
	ptr, count, found, err := f.database.GetReadState(context.Background(), f.reader, f.ch)
	if err != nil {
		t.Fatalf("GetReadState: %v", err)
	}
	return ptr, count, found
}

func (f *rpFixture) exec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := f.database.ExecContext(context.Background(), q, args...); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}

func wantRP(t *testing.T, got db.ReadPointer, ptr, unread, mentions int64) {
	t.Helper()
	if got.LastReadMessageID != ptr || got.UnreadCount != unread || got.MentionCount != mentions {
		t.Errorf("read pointer = {ptr %d, unread %d, mentions %d}, want {ptr %d, unread %d, mentions %d}",
			got.LastReadMessageID, got.UnreadCount, got.MentionCount, ptr, unread, mentions)
	}
}

func TestMoveReadPointer_MarkReadIsForwardOnly(t *testing.T) {
	f := newRPFixture(t, 5)
	wantRP(t, f.move(t, db.ReadUpTo, f.msgs[3]), f.msgs[3], 1, 0)
	// A late mark_read from a displaced device must not undo the progress.
	wantRP(t, f.move(t, db.ReadUpTo, f.msgs[1]), f.msgs[3], 1, 0)
	if ptr, _, _ := f.row(t); ptr != f.msgs[3] {
		t.Errorf("stored pointer = %d, want %d", ptr, f.msgs[3])
	}
}

func TestMoveReadPointer_ClampsHugeIDToChannelMax(t *testing.T) {
	f := newRPFixture(t, 3)
	wantRP(t, f.move(t, db.ReadUpTo, 1<<40), f.msgs[2], 0, 0)
	// A message added after is still unread, not hidden by the huge id.
	next := f.newMessage(t)
	rs := f.move(t, db.ReadUpTo, f.msgs[0])
	wantRP(t, rs, f.msgs[2], 1, 0)
	if next <= rs.LastReadMessageID {
		t.Fatalf("new message %d is not after the pointer %d", next, rs.LastReadMessageID)
	}
}

func TestMoveReadPointer_PartialReadKeepsLaterMentions(t *testing.T) {
	f := newRPFixture(t, 5)
	f.mention(t, f.msgs[1])
	f.mention(t, f.msgs[3])
	wantRP(t, f.move(t, db.ReadUpTo, f.msgs[2]), f.msgs[2], 2, 1)
	wantRP(t, f.move(t, db.ReadUpTo, f.msgs[4]), f.msgs[4], 0, 0)
}

func TestMoveReadPointer_AtLatestMatchesMarkChannelReadAtLatest(t *testing.T) {
	f := newRPFixture(t, 4)
	other := seedUser(t, f.database, "rp-other")
	f.mention(t, f.msgs[2])
	if _, err := f.database.IncrementMentionCountsBatch(context.Background(), f.ch,
		[]db.MentionBatchEntry{{MsgID: f.msgs[2], UserIDs: []int64{other}}}); err != nil {
		t.Fatalf("IncrementMentionCountsBatch: %v", err)
	}
	// A deleted newest message is not the latest.
	f.exec(t, `UPDATE messages SET deleted = 1 WHERE id = ?`, f.msgs[3])

	wantRP(t, f.move(t, db.ReadAtLatest, 0), f.msgs[2], 0, 0)
	if err := f.database.MarkChannelReadAtLatest(context.Background(), other, f.ch); err != nil {
		t.Fatalf("MarkChannelReadAtLatest: %v", err)
	}
	wantPtr, wantCount, _, err := f.database.GetReadState(context.Background(), other, f.ch)
	if err != nil {
		t.Fatalf("GetReadState: %v", err)
	}
	if ptr, count, _ := f.row(t); ptr != wantPtr || count != wantCount {
		t.Errorf("MoveReadPointer row = (%d,%d), MarkChannelReadAtLatest row = (%d,%d)", ptr, count, wantPtr, wantCount)
	}
}

func TestMoveReadPointer_UnreadRestoresMentionsAfterPointer(t *testing.T) {
	f := newRPFixture(t, 5)
	f.mention(t, f.msgs[1])
	f.mention(t, f.msgs[3])
	wantRP(t, f.move(t, db.ReadAtLatest, 0), f.msgs[4], 0, 0)
	// Unread from msgs[3]: the pointer is msgs[2]; the mention on msgs[3] is back.
	wantRP(t, f.move(t, db.MarkUnread, f.msgs[3]), f.msgs[2], 2, 1)
	// Unread from msgs[1]: both mentions are after the pointer msgs[0].
	wantRP(t, f.move(t, db.MarkUnread, f.msgs[1]), f.msgs[0], 4, 2)
	// Same place again is a no-op.
	wantRP(t, f.move(t, db.MarkUnread, f.msgs[1]), f.msgs[0], 4, 2)
}

func TestMoveReadPointer_UnreadOfFirstMessageGivesZero(t *testing.T) {
	f := newRPFixture(t, 3)
	f.move(t, db.ReadAtLatest, 0)
	wantRP(t, f.move(t, db.MarkUnread, f.msgs[0]), 0, 3, 0)
	if ptr, _, found := f.row(t); !found || ptr != 0 {
		t.Errorf("row = (ptr %d, found %v), want (0, true)", ptr, found)
	}
}

func TestMoveReadPointer_UnreadDeletedOrForeignMessageNotFound(t *testing.T) {
	f := newRPFixture(t, 4)
	f.mention(t, f.msgs[3])
	f.move(t, db.ReadAtLatest, 0)
	otherCh := seedChannel(t, f.database, "rp-other-ch")
	foreign, err := f.database.CreateMessage(context.Background(), otherCh, f.author, "elsewhere", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	f.exec(t, `UPDATE messages SET deleted = 1 WHERE id = ?`, f.msgs[2])

	for name, id := range map[string]int64{"deleted": f.msgs[2], "foreign": foreign, "missing": 1 << 40} {
		_, err := f.database.MoveReadPointer(context.Background(), f.reader, f.ch, db.MarkUnread, id)
		if !errors.Is(err, db.ErrNotFound) {
			t.Errorf("%s: err = %v, want ErrNotFound", name, err)
		}
	}
	ptr, count, found := f.row(t)
	if !found || ptr != f.msgs[3] || count != 0 {
		t.Errorf("row after refused unread = (%d,%d,%v), want (%d,0,true): a refused move must change nothing", ptr, count, found, f.msgs[3])
	}
	if _, _, found, err := f.database.GetReadState(context.Background(), f.reader, otherCh); err != nil || found {
		t.Errorf("foreign channel row found=%v err=%v, want none", found, err)
	}
}

func TestMoveReadPointer_PendingIncrementAfterUnreadCountsOnce(t *testing.T) {
	f := newRPFixture(t, 3)
	f.move(t, db.ReadAtLatest, 0)
	// A new message whose increment is still waiting for the worker.
	pending := f.newMessage(t)
	// Mark Unread of it commits first: the pointer is the message before.
	wantRP(t, f.move(t, db.MarkUnread, pending), f.msgs[2], 1, 0)
	// The deferred increment now lands: counted once, with its receipt.
	f.mention(t, pending)
	if _, count, _ := f.row(t); count != 1 {
		t.Fatalf("count after the pending increment = %d, want 1", count)
	}
	// A later recompute must not count it a second time.
	wantRP(t, f.move(t, db.MarkUnread, pending), f.msgs[2], 1, 1)
	wantRP(t, f.move(t, db.MarkUnread, f.msgs[2]), f.msgs[1], 2, 1)
}

// Edge case: a mention increment racing a backward move ends with a count equal
// to the receipts after the pointer, whichever commits first.
func TestMoveReadPointer_IncrementRacingUnreadMatchesReceipts(t *testing.T) {
	f := newRPFixture(t, 2)
	ctx := context.Background()
	for round := range 60 {
		f.move(t, db.ReadAtLatest, 0)
		f.exec(t, `DELETE FROM mention_receipts WHERE user_id = ?`, f.reader)
		msg := f.newMessage(t)

		var wg sync.WaitGroup
		wg.Add(2)
		var incErr, mvErr error
		go func() {
			defer wg.Done()
			_, incErr = f.database.IncrementMentionCountsBatch(ctx, f.ch,
				[]db.MentionBatchEntry{{MsgID: msg, UserIDs: []int64{f.reader}}})
		}()
		go func() {
			defer wg.Done()
			_, mvErr = f.database.MoveReadPointer(ctx, f.reader, f.ch, db.MarkUnread, msg)
		}()
		wg.Wait()
		if incErr != nil || mvErr != nil {
			t.Fatalf("round %d: increment err %v, move err %v", round, incErr, mvErr)
		}

		ptr, count, _ := f.row(t)
		var receipts int64
		if err := f.database.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM mention_receipts WHERE user_id = ? AND channel_id = ? AND message_id > ?`,
			f.reader, f.ch, ptr).Scan(&receipts); err != nil {
			t.Fatalf("count receipts: %v", err)
		}
		if count != receipts {
			t.Fatalf("round %d: mention_count %d != receipts after pointer %d (ptr %d)", round, count, receipts, ptr)
		}
	}
}

func TestMoveReadPointer_ForwardNeverRaisesBackwardNeverLowers(t *testing.T) {
	f := newRPFixture(t, 5)
	f.mention(t, f.msgs[3]) // one receipt, after msgs[2]

	// Counter above the ledger (a stale or guessed total): a forward move that
	// still leaves the receipt after it clamps down to the ledger and no more.
	f.exec(t, `UPDATE read_states SET mention_count = 5 WHERE user_id = ? AND channel_id = ?`, f.reader, f.ch)
	wantRP(t, f.move(t, db.ReadUpTo, f.msgs[2]), f.msgs[2], 2, 1)

	// Counter below the ledger: a forward move cannot raise it.
	f.exec(t, `UPDATE read_states SET last_message_id = 0, mention_count = 0 WHERE user_id = ? AND channel_id = ?`, f.reader, f.ch)
	wantRP(t, f.move(t, db.ReadUpTo, f.msgs[2]), f.msgs[2], 2, 0)

	// Backward with a counter above the ledger: it is not lowered.
	f.exec(t, `UPDATE read_states SET last_message_id = ?, mention_count = 5 WHERE user_id = ? AND channel_id = ?`, f.msgs[4], f.reader, f.ch)
	wantRP(t, f.move(t, db.MarkUnread, f.msgs[2]), f.msgs[1], 3, 5)
	// Backward with a counter below the ledger: it is raised to the ledger.
	f.exec(t, `UPDATE read_states SET last_message_id = ?, mention_count = 0 WHERE user_id = ? AND channel_id = ?`, f.msgs[4], f.reader, f.ch)
	wantRP(t, f.move(t, db.MarkUnread, f.msgs[2]), f.msgs[1], 3, 1)
}

func TestMoveReadPointer_PointerMessageDeletedKeepsCounts(t *testing.T) {
	f := newRPFixture(t, 4)
	f.mention(t, f.msgs[3])
	wantRP(t, f.move(t, db.ReadUpTo, f.msgs[1]), f.msgs[1], 2, 1)
	f.exec(t, `UPDATE messages SET deleted = 1 WHERE id = ?`, f.msgs[1])
	// The pointer is an id: deleting the message it names changes nothing.
	wantRP(t, f.move(t, db.ReadUpTo, f.msgs[0]), f.msgs[1], 2, 1)
	// A deleted mentioning message drops out of the ledger count.
	f.exec(t, `UPDATE messages SET deleted = 1 WHERE id = ?`, f.msgs[3])
	f.move(t, db.ReadAtLatest, 0)
	wantRP(t, f.move(t, db.MarkUnread, f.msgs[2]), f.msgs[1], 1, 0)
}

func TestMoveReadPointer_BlockedAuthorReceiptsNotCounted(t *testing.T) {
	f := newRPFixture(t, 3)
	f.mention(t, f.msgs[2])
	f.move(t, db.ReadAtLatest, 0)
	if err := f.database.BlockUser(context.Background(), f.reader, f.author); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	wantRP(t, f.move(t, db.MarkUnread, f.msgs[1]), f.msgs[0], 2, 0)
}
