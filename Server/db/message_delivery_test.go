package db_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

func storageDeliveryParams(userID, channelID int64) db.MessageDeliveryParams {
	hash := sha256.Sum256([]byte("immutable request"))
	return db.MessageDeliveryParams{
		UserID: userID, ChannelID: channelID, ClientMessageID: "stable-logical-id",
		PayloadHash: hash[:], Content: "one message", ExpiresAtMS: time.Now().Add(time.Hour).UnixMilli(),
	}
}

func TestMessageDelivery_ReceiptSurvivesDatabaseReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "delivery.sqlite")
	open := func() *db.DB {
		t.Helper()
		database, err := db.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := db.Migrate(database); err != nil {
			_ = database.Close()
			t.Fatal(err)
		}
		return database
	}
	database := open()
	ctx := context.Background()
	p := storageDeliveryParams(seedUser(t, database, "alice"), seedChannel(t, database, "general"))
	first, err := database.CreateMessageDelivery(ctx, p)
	if err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	database = open()
	t.Cleanup(func() { _ = database.Close() })
	retry, err := database.CreateMessageDelivery(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if !retry.Duplicate || retry.Message.ID != first.Message.ID || retry.Message.Timestamp != first.Message.Timestamp {
		t.Fatalf("reopened retry = %+v, original = %+v", retry, first)
	}
	var count int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("reopen retry stored %d messages", count)
	}
}

func TestMessageDelivery_ExpiredReceiptsPrunedWithoutRecreatingMessage(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	p := storageDeliveryParams(seedUser(t, database, "alice"), seedChannel(t, database, "general"))
	if _, err := database.CreateMessageDelivery(ctx, p); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE message_delivery_receipts SET expires_at_ms = 0`); err != nil {
		t.Fatal(err)
	}
	if err := database.DeleteExpiredMessageDeliveryReceipts(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM message_delivery_receipts`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("expired receipts = %d", count)
	}
	p.ExpiresAtMS = time.Now().Add(-time.Minute).UnixMilli()
	if _, err := database.CreateMessageDelivery(ctx, p); !errors.Is(err, db.ErrMessageDeliveryExpired) {
		t.Fatalf("expired send after prune = %v", err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("pruned retry stored %d messages", count)
	}
}

func TestMessageDelivery_ErasureRemovesOnlySubjectsReceipts(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	subject := seedUser(t, database, "alice")
	other := seedUser(t, database, "bob")
	channel := seedChannel(t, database, "general")
	for _, uid := range []int64{subject, other} {
		if _, err := database.CreateMessageDelivery(ctx, storageDeliveryParams(uid, channel)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := database.EraseAccount(ctx, subject, "erased-test-subject"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM message_delivery_receipts WHERE user_id = ?`, subject).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("erased sender left %d receipts", count)
	}
	remaining, err := database.FindMessageDelivery(ctx, storageDeliveryParams(other, channel))
	if err != nil || remaining == nil || !remaining.Duplicate {
		t.Fatalf("unrelated sender receipt = %+v, %v", remaining, err)
	}
}

func TestMessageDelivery_FailedReceiptInsertRollsBackMessageMentionsAndAttachments(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	userID := seedUser(t, database, "alice")
	other := seedUser(t, database, "bob")
	p := storageDeliveryParams(userID, seedChannel(t, database, "general"))
	p.MentionedUserIDs = []int64{other}
	p.AttachmentIDs = []string{"owned"}
	if err := database.CreateAttachment(ctx, "owned", userID, "a.txt", "a.txt", "text/plain", 1, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `CREATE TRIGGER fail_delivery BEFORE INSERT ON message_delivery_receipts BEGIN SELECT RAISE(ABORT, 'disk-write-simulation'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateMessageDelivery(ctx, p); err == nil {
		t.Fatal("expected receipt write failure")
	}
	for _, query := range []string{`SELECT COUNT(*) FROM messages`, `SELECT COUNT(*) FROM message_mentions`, `SELECT COUNT(*) FROM message_delivery_receipts`} {
		var count int
		if err := database.QueryRowContext(ctx, query).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("partial commit: %s = %d", query, count)
		}
	}
	attachment, err := database.GetAttachmentByID(ctx, "owned")
	if err != nil || attachment == nil || attachment.MessageID != nil {
		t.Fatalf("attachment not rolled back: %+v, %v", attachment, err)
	}
	if _, err := database.ExecContext(ctx, `DROP TRIGGER fail_delivery`); err != nil {
		t.Fatal(err)
	}
	if retry, err := database.CreateMessageDelivery(ctx, p); err != nil || retry.Duplicate {
		t.Fatalf("retry after rollback = %+v, %v", retry, err)
	}
}
