package db_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

var forwardSeq int

// forwardFixture is a source message with one file in a source channel, and a
// forwarder with an unlinked clone of that file waiting for the target.
type forwardFixture struct {
	database           *db.DB
	author, forwarder  int64
	srcChannel, target int64
	srcID              int64
	srcTimestamp       string
	cloneID            string
}

func newForwardFixture(t *testing.T) forwardFixture {
	t.Helper()
	database := openMigratedMemory(t)
	f := forwardFixture{database: database}
	f.author = seedUser(t, database, "author")
	f.forwarder = seedUser(t, database, "forwarder")
	f.srcChannel = seedChannel(t, database, "source")
	f.target = seedChannel(t, database, "target")
	f.srcID = seedAttached(t, database, f.srcChannel, f.author, "the original", "image/png")
	src, err := database.GetMessage(context.Background(), f.srcID)
	if err != nil || src == nil {
		t.Fatalf("GetMessage: %v %v", src, err)
	}
	f.srcTimestamp = src.Timestamp
	f.cloneID = seedUnlinked(t, database, f.forwarder, "image/png")
	return f
}

// params builds a forward send with a fresh logical id and the clone attached.
func (f forwardFixture) params(content string, attachments ...string) db.MessageDeliveryParams {
	forwardSeq++
	hash := sha256.Sum256([]byte(fmt.Sprintf("forward %d", forwardSeq)))
	return db.MessageDeliveryParams{
		UserID: f.forwarder, ChannelID: f.target, ClientMessageID: fmt.Sprintf("fwd-%d", forwardSeq),
		PayloadHash: hash[:], Content: content, AttachmentIDs: attachments,
		ExpiresAtMS: time.Now().Add(time.Hour).UnixMilli(),
		Forward: &db.ForwardRow{
			SourceMessageID: &f.srcID, SourceChannelID: f.srcChannel,
			SourceTimestamp: f.srcTimestamp, ForwardedID: f.srcID,
		},
	}
}

func (f forwardFixture) count(t *testing.T, q string, args ...any) int {
	t.Helper()
	var n int
	if err := f.database.QueryRowContext(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	return n
}

func TestCreateMessageDelivery_ForwardAtomic(t *testing.T) {
	f := newForwardFixture(t)
	ctx := context.Background()

	// Injected failure on the side row: the message, the receipt and the link
	// of the clone all roll back with it.
	if _, err := f.database.ExecContext(ctx,
		`CREATE TRIGGER inject_forward_failure BEFORE INSERT ON message_forwards
		 BEGIN SELECT RAISE(ABORT, 'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.database.CreateMessageDelivery(ctx, f.params("the original", f.cloneID)); err == nil {
		t.Fatal("injected failure did not fail the forward")
	}
	if n := f.count(t, `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, f.target); n != 0 {
		t.Errorf("failed forward left %d messages", n)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_delivery_receipts WHERE user_id = ?`, f.forwarder); n != 0 {
		t.Errorf("failed forward left %d receipts", n)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM attachments WHERE id = ? AND message_id IS NULL`, f.cloneID); n != 1 {
		t.Error("failed forward left the clone linked")
	}
	if _, err := f.database.ExecContext(ctx, `DROP TRIGGER inject_forward_failure`); err != nil {
		t.Fatal(err)
	}

	// The same forward without the failure commits message, side row, receipt
	// and the clone link together.
	p := f.params("the original", f.cloneID)
	saved, err := f.database.CreateMessageDelivery(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Duplicate || len(saved.LinkedAttachmentIDs) != 1 {
		t.Fatalf("saved = %+v", saved)
	}
	row, err := f.database.GetMessageForward(ctx, saved.Message.ID)
	if err != nil || row == nil {
		t.Fatalf("GetMessageForward = %v, %v", row, err)
	}
	if row.SourceMessageID == nil || *row.SourceMessageID != f.srcID || row.SourceChannelID != f.srcChannel || row.SourceTimestamp != f.srcTimestamp {
		t.Errorf("forward row = %+v", row)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM attachments WHERE id = ? AND message_id = ?`, f.cloneID, saved.Message.ID); n != 1 {
		t.Error("clone is not linked to the forward")
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_mentions WHERE message_id = ?`, saved.Message.ID); n != 0 {
		t.Errorf("a forward wrote %d mention rows", n)
	}
	// A retry is answered from the receipt: no second message or side row.
	retry, err := f.database.CreateMessageDelivery(ctx, p)
	if err != nil || !retry.Duplicate || retry.Message.ID != saved.Message.ID {
		t.Fatalf("retry = %+v, %v", retry, err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_forwards`); n != 1 {
		t.Errorf("message_forwards rows = %d, want 1", n)
	}
}

func TestCreateMessageDelivery_ForwardSourceDeletedInTx(t *testing.T) {
	f := newForwardFixture(t)
	ctx := context.Background()
	// A delete that commits before the forward's transaction wins.
	if err := f.database.DeleteMessage(ctx, f.srcID, f.author, false); err != nil {
		t.Fatal(err)
	}
	_, err := f.database.CreateMessageDelivery(ctx, f.params("the original", f.cloneID))
	if !errors.Is(err, db.ErrForwardSourceGone) {
		t.Fatalf("err = %v, want ErrForwardSourceGone", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, f.target); n != 0 {
		t.Errorf("refused forward left %d messages", n)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_forwards`); n != 0 {
		t.Errorf("refused forward left %d side rows", n)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM attachments WHERE id = ? AND message_id IS NULL`, f.cloneID); n != 1 {
		t.Error("the clone must stay unlinked for the sweep")
	}
	// A row that is not an ordinary message is refused the same way.
	if _, err := f.database.ExecContext(ctx, `UPDATE messages SET deleted = 0, kind = 1 WHERE id = ?`, f.srcID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.database.CreateMessageDelivery(ctx, f.params("x", f.cloneID)); !errors.Is(err, db.ErrForwardSourceGone) {
		t.Fatalf("kind != 0 source: err = %v, want ErrForwardSourceGone", err)
	}
}

func TestForward_SourcePurgedNullsLink(t *testing.T) {
	f := newForwardFixture(t)
	ctx := context.Background()
	saved, err := f.database.CreateMessageDelivery(ctx, f.params("the original", f.cloneID))
	if err != nil {
		t.Fatal(err)
	}
	// A purge (retention, erasure) hard-deletes the source row.
	if _, err := f.database.ExecContext(ctx, `DELETE FROM messages WHERE id = ?`, f.srcID); err != nil {
		t.Fatal(err)
	}
	row, err := f.database.GetMessageForward(ctx, saved.Message.ID)
	if err != nil || row == nil {
		t.Fatalf("the forward lost its side row: %v %v", row, err)
	}
	if row.SourceMessageID != nil || row.SourceChannelID != f.srcChannel {
		t.Errorf("row after purge = %+v, want a null link and the channel kept", row)
	}
	// Deleting the source channel cascades its messages, which nulls the link
	// of a forward made from a second message there.
	second := seedAttached(t, f.database, f.srcChannel, f.author, "second", "image/png")
	clone2 := seedUnlinked(t, f.database, f.forwarder, "image/png")
	p := f.params("second", clone2)
	p.Forward.SourceMessageID, p.Forward.ForwardedID = &second, second
	saved2, err := f.database.CreateMessageDelivery(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.database.DeleteChannel(ctx, f.srcChannel); err != nil {
		t.Fatal(err)
	}
	row2, err := f.database.GetMessageForward(ctx, saved2.Message.ID)
	if err != nil || row2 == nil || row2.SourceMessageID != nil {
		t.Fatalf("row after channel delete = %+v, %v", row2, err)
	}
}

func TestEditMessageContent_RefusesForward(t *testing.T) {
	f := newForwardFixture(t)
	ctx := context.Background()
	saved, err := f.database.CreateMessageDelivery(ctx, f.params("the original", f.cloneID))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.database.EditMessage(ctx, saved.Message.ID, f.forwarder, "rewritten"); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("EditMessage(forward) err = %v, want ErrNotFound", err)
	}
	got, err := f.database.GetMessage(ctx, saved.Message.ID)
	if err != nil || got == nil || got.Content != "the original" || got.EditedAt != nil {
		t.Fatalf("forward after refused edit = %+v, %v", got, err)
	}
	// An ordinary message by the same user still edits.
	id, err := f.database.CreateMessage(ctx, f.target, f.forwarder, "mine", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.database.EditMessage(ctx, id, f.forwarder, "mine, edited"); err != nil {
		t.Fatalf("ordinary edit: %v", err)
	}
}

func TestAttachForwards_DeletedSourceHidesLink(t *testing.T) {
	f := newForwardFixture(t)
	ctx := context.Background()
	saved, err := f.database.CreateMessageDelivery(ctx, f.params("the original", f.cloneID))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := f.database.CreateMessage(ctx, f.target, f.forwarder, "plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	page := func() map[int64]db.MessageAPIResponse {
		t.Helper()
		msgs, err := f.database.GetMessagesForAPI(ctx, f.target, 0, 50, f.forwarder)
		if err != nil {
			t.Fatal(err)
		}
		out := map[int64]db.MessageAPIResponse{}
		for i := range msgs {
			out[msgs[i].ID] = msgs[i]
		}
		return out
	}

	got := page()
	fw := got[saved.Message.ID].Forward
	if fw == nil || fw.SourceMessageID == nil || *fw.SourceMessageID != f.srcID || fw.SourceChannelID != f.srcChannel || fw.SourceTimestamp != f.srcTimestamp {
		t.Fatalf("forward block = %+v", fw)
	}
	if got[plain].Forward != nil {
		t.Errorf("an ordinary message carries a forward block: %+v", got[plain].Forward)
	}
	if len(got[saved.Message.ID].Attachments) != 1 {
		t.Errorf("forward attachments = %d, want its clone", len(got[saved.Message.ID].Attachments))
	}

	// A soft delete of the source leaves the id in the row but reports it null.
	if err := f.database.DeleteMessage(ctx, f.srcID, f.author, false); err != nil {
		t.Fatal(err)
	}
	fw = page()[saved.Message.ID].Forward
	if fw == nil || fw.SourceMessageID != nil || fw.SourceChannelID != f.srcChannel {
		t.Fatalf("forward block after the source was deleted = %+v", fw)
	}

	// A deleted forward carries no block at all.
	if err := f.database.DeleteMessage(ctx, saved.Message.ID, f.forwarder, false); err != nil {
		t.Fatal(err)
	}
	if d, ok := page()[saved.Message.ID]; ok && d.Forward != nil {
		t.Errorf("a deleted forward still carries its block: %+v", d.Forward)
	}
}
