package db

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestMessageDeliveryFloor_RestoreRejectsLostReceiptButAcknowledgesRetainedReceipt(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "chat.db")
	backup := filepath.Join(dir, "backup.db")
	ctx := context.Background()
	database, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := Migrate(database); err != nil {
		t.Fatal(err)
	}
	userID, err := database.CreateUser(ctx, "cutoff-alice", "test-hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	channelID, err := database.CreateChannel(ctx, "cutoff-general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	// The first client clock is at the greatest timestamp validation permits,
	// so a bare wall-clock cutoff at restore time would not reject its retry.
	created := time.Now().Add(MessageDeliveryClockSkew).UnixMilli()
	params := func(content string, createdMS int64) MessageDeliveryParams {
		hash := sha256.Sum256([]byte(content))
		return MessageDeliveryParams{
			UserID: userID, ChannelID: channelID, Content: content,
			ClientMessageID: fmt.Sprintf("%d:%s", createdMS, uuid.NewString()),
			PayloadHash:     hash[:], CreatedAtMS: createdMS,
			ExpiresAtMS: createdMS + (24 * time.Hour).Milliseconds(),
		}
	}
	retained := params("kept in backup", created)
	original, err := database.CreateMessageDelivery(ctx, retained)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.BackupToSafe(ctx, backup, dir); err != nil {
		t.Fatal(err)
	}
	lost := params("receipt lost by restore", created)
	if _, err := database.CreateMessageDelivery(ctx, lost); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if err := AdvanceMessageDeliveryFloorForRestore(path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	database = restored
	if database.MessageDeliveryFloorMS() <= created {
		t.Fatal("restore cutoff did not cover the previously accepted future timestamp")
	}
	if _, err := database.FindMessageDelivery(ctx, lost); !errors.Is(err, ErrMessageDeliveryBeforeRestore) {
		t.Fatalf("lost receipt lookup = %v, want pre-restore refusal", err)
	}
	if _, err := database.CreateMessageDelivery(ctx, lost); !errors.Is(err, ErrMessageDeliveryBeforeRestore) {
		t.Fatalf("lost receipt write = %v, want pre-restore refusal", err)
	}
	for _, retry := range []func(context.Context, MessageDeliveryParams) (*MessageDelivery, error){
		database.FindMessageDelivery, database.CreateMessageDelivery,
	} {
		got, retryErr := retry(ctx, retained)
		if retryErr != nil || got == nil || !got.Duplicate || got.Message.ID != original.Message.ID {
			t.Fatalf("retained receipt below cutoff = %+v, %v", got, retryErr)
		}
	}
	fresh := params("new message after restore", database.MessageDeliveryFloorMS())
	if got, err := database.CreateMessageDelivery(ctx, fresh); err != nil || got == nil || got.Duplicate {
		t.Fatalf("new message at cutoff = %+v, %v", got, err)
	}
	var count int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("restored database contains %d messages, want retained plus new", count)
	}
}

func TestMessageDeliveryFloor_PersistsAcrossReopenAndNeverMovesBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.db")
	assertFloor := func(want int64) {
		t.Helper()
		database, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := database.MessageDeliveryFloorMS(); got != want {
			t.Errorf("message retry floor = %d, want %d", got, want)
		}
		if err := database.Close(); err != nil {
			t.Fatal(err)
		}
	}
	assertFloor(0)
	now := time.Now().Truncate(time.Millisecond)
	want := now.Add(MessageDeliveryClockSkew).UnixMilli() + 1
	if err := advanceMessageDeliveryFloor(path, now); err != nil {
		t.Fatal(err)
	}
	assertFloor(want)
	// A second restore under a clock that moved backwards cannot reopen ids.
	if err := advanceMessageDeliveryFloor(path, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	assertFloor(want)
	if err := advanceMessageDeliveryFloor(path, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	assertFloor(want + time.Minute.Milliseconds())
	leftovers, err := filepath.Glob(filepath.Join(filepath.Dir(path), ".message-retry-floor-*"))
	if err != nil || len(leftovers) != 0 {
		t.Fatalf("temporary cutoffs remain: %v, %v", leftovers, err)
	}
}

func TestMessageDeliveryFloor_RejectsMalformedFileAndReleasesStartupLock(t *testing.T) {
	for _, data := range []string{"", "123\n", "-123456789012\n", "0123456789012\n", "not-a-cutoff!\n", strings.Repeat("1", 128)} {
		t.Run(strconv.Itoa(len(data))+data[:min(len(data), 3)], func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "chat.db")
			sidecar, err := messageDeliveryFloorPath(path)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(sidecar, []byte(data), 0o600); err != nil {
				t.Fatal(err)
			}
			if database, err := Open(path); err == nil {
				_ = database.Close()
				t.Fatal("startup accepted a malformed retry cutoff")
			}
			if err := AdvanceMessageDeliveryFloorForRestore(path); err == nil {
				t.Fatal("restore overwrote an unreadable prior cutoff")
			}
			if err := os.Remove(sidecar); err != nil {
				t.Fatal(err)
			}
			// A failed startup must release its process lock for the retry.
			database, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			if err := database.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMessageDeliveryFloor_RejectsUnreadableAndUnwritablePaths(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.db")
	sidecar, err := messageDeliveryFloorPath(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(sidecar, 0o700); err != nil {
		t.Fatal(err)
	}
	if database, err := Open(path); err == nil {
		_ = database.Close()
		t.Fatal("startup treated a directory as an absent cutoff")
	}
	if err := AdvanceMessageDeliveryFloorForRestore(path); err == nil {
		t.Fatal("restore accepted an unreadable existing cutoff")
	}
	missingDir := filepath.Join(t.TempDir(), "missing", "chat.db")
	if err := AdvanceMessageDeliveryFloorForRestore(missingDir); err == nil {
		t.Fatal("restore succeeded without a directory to persist its cutoff")
	}
}

func TestMessageDeliveryFloor_FileURIMatchesPlainDatabasePath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.db")
	if err := AdvanceMessageDeliveryFloorForRestore(path); err != nil {
		t.Fatal(err)
	}
	want, err := readMessageDeliveryFloor(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := readMessageDeliveryFloor("file:" + filepath.ToSlash(path) + "?mode=rwc")
	if err != nil || got != want {
		t.Fatalf("URI cutoff = %d, %v; want %d", got, err, want)
	}
	if err := AdvanceMessageDeliveryFloorForRestore(":memory:"); err == nil {
		t.Fatal("in-memory restore claimed durable retry protection")
	}
}
