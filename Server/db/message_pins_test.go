package db_test

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

type pinFixture struct {
	database       *db.DB
	alice, bob, ch int64
	target         int64
}

func newPinFixture(t *testing.T) pinFixture {
	t.Helper()
	database := openMigratedMemory(t)
	alice := seedUser(t, database, "alice")
	bob := seedUser(t, database, "bob")
	ch := seedChannel(t, database, "general")
	target, err := database.CreateMessage(context.Background(), ch, bob, "pin me", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	return pinFixture{database: database, alice: alice, bob: bob, ch: ch, target: target}
}

func (f pinFixture) pin(t *testing.T, pinned bool, now time.Time) *db.PinEventRow {
	t.Helper()
	row, err := f.database.SetMessagePinned(context.Background(), db.SetPinnedParams{
		MessageID: f.target, Pinned: pinned, UserID: f.alice, Username: "alice", Now: now,
	})
	if err != nil {
		t.Fatalf("SetMessagePinned(%v): %v", pinned, err)
	}
	return row
}

func (f pinFixture) pinRows(t *testing.T) int {
	t.Helper()
	return count(t, f.database, `SELECT COUNT(*) FROM messages WHERE kind = 7 AND reply_to = ?`, f.target)
}

func TestSetMessagePinned_WritesOneRowAtomically(t *testing.T) {
	f := newPinFixture(t)
	row := f.pin(t, true, time.Time{})
	if row == nil {
		t.Fatal("pin wrote no row")
	}
	if row.PinnedMessageID != f.target || row.ChannelID != f.ch || row.UserID != f.alice {
		t.Errorf("row = %+v, want target %d channel %d author %d", row, f.target, f.ch, f.alice)
	}
	if want := "alice pinned a message to this channel."; row.Content != want {
		t.Errorf("content = %q, want %q", row.Content, want)
	}
	if got := count(t, f.database, `SELECT pinned FROM messages WHERE id = ?`, f.target); got != 1 {
		t.Errorf("pinned = %d, want 1", got)
	}
	if got := count(t, f.database, `SELECT kind FROM messages WHERE id = ?`, row.MessageID); got != 7 {
		t.Errorf("row kind = %d, want 7", got)
	}
	if got := count(t, f.database, `SELECT reply_to FROM messages WHERE id = ?`, row.MessageID); int64(got) != f.target {
		t.Errorf("row reply_to = %d, want %d", got, f.target)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM message_mentions WHERE message_id = ?`, row.MessageID); got != 0 {
		t.Errorf("mention rows = %d, want 0", got)
	}
	if got := count(t, f.database, `SELECT mentions_everyone FROM messages WHERE id = ?`, row.MessageID); got != 0 {
		t.Errorf("mentions_everyone = %d, want 0", got)
	}
	// The pinner's read state is past their own row.
	if got := count(t, f.database, `SELECT last_message_id FROM read_states WHERE user_id = ? AND channel_id = ?`, f.alice, f.ch); int64(got) != row.MessageID {
		t.Errorf("pinner read state = %d, want %d", got, row.MessageID)
	}
}

func TestSetMessagePinned_RepinAndFlapWriteOneRow(t *testing.T) {
	f := newPinFixture(t)
	t0 := time.Now().UTC()
	if f.pin(t, true, t0) == nil {
		t.Fatal("first pin wrote no row")
	}
	// A re-pin of an already pinned message writes nothing.
	if f.pin(t, true, t0.Add(time.Minute)) != nil {
		t.Error("re-pin wrote a row")
	}
	// An unpin writes nothing.
	if f.pin(t, false, t0.Add(2*time.Minute)) != nil {
		t.Error("unpin wrote a row")
	}
	// Pin again inside the window: the flap writes nothing more.
	if f.pin(t, true, t0.Add(3*time.Minute)) != nil {
		t.Error("flap pin inside the window wrote a row")
	}
	if got := f.pinRows(t); got != 1 {
		t.Fatalf("pin rows after flapping = %d, want 1", got)
	}
	// Outside the window a fresh pin writes a second row.
	f.pin(t, false, t0.Add(4*time.Minute))
	if f.pin(t, true, t0.Add(11*time.Minute)) == nil {
		t.Error("pin after the window wrote no row")
	}
	if got := f.pinRows(t); got != 2 {
		t.Errorf("pin rows after the window = %d, want 2", got)
	}
}

func TestSetMessagePinned_ConcurrentPinsWriteOneRow(t *testing.T) {
	f := newPinFixture(t)
	const n = 8
	errs := make(chan error, n)
	for range n {
		go func() {
			_, err := f.database.SetMessagePinned(context.Background(), db.SetPinnedParams{
				MessageID: f.target, Pinned: true, UserID: f.alice, Username: "alice",
			})
			errs <- err
		}()
	}
	for range n {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent pin: %v", err)
		}
	}
	if got := f.pinRows(t); got != 1 {
		t.Errorf("pin rows after %d racing pins = %d, want 1", n, got)
	}
}

func TestSetMessagePinned_RowInsertFailureRollsBackPin(t *testing.T) {
	f := newPinFixture(t)
	// An author that does not exist fails the foreign key on the row insert.
	_, err := f.database.SetMessagePinned(context.Background(), db.SetPinnedParams{
		MessageID: f.target, Pinned: true, UserID: 99999, Username: "ghost",
	})
	if err == nil {
		t.Fatal("pin with an unknown author succeeded")
	}
	if got := count(t, f.database, `SELECT pinned FROM messages WHERE id = ?`, f.target); got != 0 {
		t.Errorf("pinned = %d after a failed row insert, want 0", got)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE pinned_at IS NOT NULL AND id = ?`, f.target); got != 0 {
		t.Errorf("pinned_at still stamped after rollback")
	}
	if got := f.pinRows(t); got != 0 {
		t.Errorf("pin rows = %d, want 0", got)
	}
}

func TestPinRow_TargetDeletedOrPurged(t *testing.T) {
	t.Run("soft deleted", func(t *testing.T) {
		f := newPinFixture(t)
		row := f.pin(t, true, time.Time{})
		if err := f.database.DeleteMessage(context.Background(), f.target, f.bob, false); err != nil {
			t.Fatalf("DeleteMessage: %v", err)
		}
		msgs, err := f.database.GetMessagesForAPI(context.Background(), f.ch, 0, 50, f.alice)
		if err != nil {
			t.Fatalf("GetMessagesForAPI: %v", err)
		}
		var found bool
		for _, m := range msgs {
			if m.ID != row.MessageID {
				continue
			}
			found = true
			if m.Kind != "pin_add" {
				t.Errorf("kind = %q, want pin_add", m.Kind)
			}
			if m.ReplyTo == nil || *m.ReplyTo != f.target {
				t.Errorf("reply_to = %v, want %d", m.ReplyTo, f.target)
			}
			if m.ReferencedMessage == nil || !m.ReferencedMessage.Deleted || m.ReferencedMessage.ID != f.target {
				t.Errorf("referenced_message = %+v, want {id, deleted:true}", m.ReferencedMessage)
			}
		}
		if !found {
			t.Fatal("pin row missing from history after its target was deleted")
		}
	})
	t.Run("purged", func(t *testing.T) {
		f := newPinFixture(t)
		row := f.pin(t, true, time.Time{})
		// Retention hard-deletes the target; the FK nulls the row's link.
		if _, err := f.database.ExecContext(context.Background(), `DELETE FROM messages WHERE id = ?`, f.target); err != nil {
			t.Fatalf("hard delete: %v", err)
		}
		if got := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE id = ? AND reply_to IS NULL AND deleted = 0`, row.MessageID); got != 1 {
			t.Fatalf("pin row after purge: survived with NULL reply_to = %d, want 1", got)
		}
		msgs, err := f.database.GetMessagesForAPI(context.Background(), f.ch, 0, 50, f.alice)
		if err != nil {
			t.Fatalf("GetMessagesForAPI: %v", err)
		}
		for _, m := range msgs {
			if m.ID == row.MessageID && (m.ReplyTo != nil || m.ReferencedMessage != nil) {
				t.Errorf("row after purge: reply_to = %v referenced = %+v, want both nil", m.ReplyTo, m.ReferencedMessage)
			}
		}
	})
}

// insertKindRow writes a bare server row of the given kind by the author.
func (f pinFixture) insertKindRow(t *testing.T, kind int64) int64 {
	t.Helper()
	res, err := f.database.ExecContext(context.Background(),
		`INSERT INTO messages (channel_id, user_id, content, kind) VALUES (?, ?, 'x', ?)`, f.ch, f.alice, kind)
	if err != nil {
		t.Fatalf("insert kind %d: %v", kind, err)
	}
	id, _ := res.LastInsertId()
	return id
}

func TestSoftDelete_PinRowDeletableCallAndGroupRowsNot(t *testing.T) {
	f := newPinFixture(t)
	pinRow := f.pin(t, true, time.Time{})
	call := f.insertKindRow(t, db.MessageKindCall)
	group := f.insertKindRow(t, db.MessageKindGroupAdd)

	if err := f.database.DeleteMessage(context.Background(), call, f.alice, true); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("delete call row: err = %v, want ErrNotFound", err)
	}
	if err := f.database.DeleteMessage(context.Background(), group, f.alice, true); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("delete group row: err = %v, want ErrNotFound", err)
	}
	if err := f.database.DeleteMessage(context.Background(), pinRow.MessageID, f.alice, false); err != nil {
		t.Fatalf("delete pin row: %v", err)
	}
	for id, want := range map[int64]int{pinRow.MessageID: 1, call: 0, group: 0} {
		if got := count(t, f.database, `SELECT deleted FROM messages WHERE id = ?`, id); got != want {
			t.Errorf("message %d deleted = %d, want %d", id, got, want)
		}
	}
}

func TestPurge_TakesPinRowsNotCallOrGroupRows(t *testing.T) {
	t.Run("channel purge", func(t *testing.T) {
		f := newPinFixture(t)
		pinRow := f.pin(t, true, time.Time{})
		call := f.insertKindRow(t, db.MessageKindCall)
		group := f.insertKindRow(t, db.MessageKindGroupLeave)
		ids, err := f.database.PurgeChannelMessages(context.Background(), f.ch, 0, 50)
		if err != nil {
			t.Fatalf("PurgeChannelMessages: %v", err)
		}
		if !slices.Contains(ids, pinRow.MessageID) || slices.Contains(ids, call) || slices.Contains(ids, group) {
			t.Errorf("purged ids = %v, want the pin row %d and neither %d nor %d", ids, pinRow.MessageID, call, group)
		}
	})
	t.Run("ban purge", func(t *testing.T) {
		f := newPinFixture(t)
		pinRow := f.pin(t, true, time.Time{})
		call := f.insertKindRow(t, db.MessageKindCall)
		group := f.insertKindRow(t, db.MessageKindGroupLeave)
		// alice authored all three rows.
		ids, err := f.database.PurgeUserChannelMessagesSince(context.Background(), f.ch, f.alice, "2000-01-01 00:00:00", 50)
		if err != nil {
			t.Fatalf("PurgeUserChannelMessagesSince: %v", err)
		}
		if !slices.Contains(ids, pinRow.MessageID) || slices.Contains(ids, call) || slices.Contains(ids, group) {
			t.Errorf("purged ids = %v, want the pin row %d and neither %d nor %d", ids, pinRow.MessageID, call, group)
		}
	})
}
