package db_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// The store's error branches, all at once: every erasure, marker and
// retention call fails cleanly on a closed handle instead of panicking or
// answering with a zero value that reads as success.
func TestErasureRetentionMarkers_ErrorsOnAClosedStore(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedUser(t, database, "closed-store")
	chID := seedChannel(t, database, "closed-chan")
	if err := database.SetChannelRetention(ctx, chID, 3, uid); err != nil {
		t.Fatal(err)
	}
	// The read paths that have rows to return before the close.
	if list, err := database.ListChannelRetention(ctx); err != nil || len(list) != 1 || list[0].Days != 3 {
		t.Fatalf("ListChannelRetention = %+v, %v", list, err)
	}
	if c, err := database.GetChannelRetention(ctx, chID); err != nil || c == nil || c.UpdatedBy != uid {
		t.Fatalf("GetChannelRetention = %+v, %v", c, err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE settings SET value = '-4' WHERE key = ?`, db.RetentionDaysKey); err != nil {
		t.Fatal(err)
	}
	if days, err := database.ServerRetentionDays(ctx); err != nil || days != 0 {
		t.Fatalf("a negative retention_days = %d, %v; want 0", days, err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	calls := map[string]func() error{
		"EraseAccount":                func() error { _, err := database.EraseAccount(ctx, uid, ""); return err },
		"ListUnfinishedErasureJobs":   func() error { _, err := database.ListUnfinishedErasureJobs(ctx); return err },
		"GetErasureJob":               func() error { _, err := database.GetErasureJob(ctx, 1); return err },
		"MarkErasureJobReplayPurged":  func() error { return database.MarkErasureJobReplayPurged(ctx, 1) },
		"RecordErasureJobAttempt":     func() error { return database.RecordErasureJobAttempt(ctx, 1, 0, "x") },
		"CompleteErasureJob":          func() error { return database.CompleteErasureJob(ctx, 1, 0) },
		"ReferencedStoredFiles":       func() error { _, err := database.ReferencedStoredFiles(ctx, []string{"a"}); return err },
		"DeleteEventsForUser":         func() error { _, err := database.DeleteEventsForUser(ctx, uid); return err },
		"ListUserIDs":                 func() error { _, err := database.ListUserIDs(ctx); return err },
		"TakeInventory":               func() error { _, err := database.TakeInventory(ctx, uid, "closed-store"); return err },
		"ServerRetentionDays":         func() error { _, err := database.ServerRetentionDays(ctx); return err },
		"ListChannelRetention":        func() error { _, err := database.ListChannelRetention(ctx); return err },
		"GetChannelRetention":         func() error { _, err := database.GetChannelRetention(ctx, chID); return err },
		"SetChannelRetention":         func() error { return database.SetChannelRetention(ctx, chID, 1, uid) },
		"DeleteChannelRetention":      func() error { _, err := database.DeleteChannelRetention(ctx, chID); return err },
		"RetentionWindows":            func() error { _, err := database.RetentionWindows(ctx); return err },
		"CountRetentionCandidates":    func() error { _, err := database.CountRetentionCandidates(ctx, chID, time.Now()); return err },
		"SweepRetention":              func() error { _, _, err := database.SweepRetention(ctx, chID, time.Now(), 10); return err },
		"StartRetentionRun":           func() error { _, err := database.StartRetentionRun(ctx); return err },
		"RecordRetentionRunFiles":     func() error { return database.RecordRetentionRunFiles(ctx, 1, 0, 0, nil) },
		"FinishRetentionRun":          func() error { return database.FinishRetentionRun(ctx, 1, 0, "") },
		"ListUnfinishedRetentionRuns": func() error { _, err := database.ListUnfinishedRetentionRuns(ctx); return err },
		"GetRetentionRun":             func() error { _, err := database.GetRetentionRun(ctx, 1); return err },
	}
	for name, call := range calls {
		if err := call(); err == nil {
			t.Errorf("%s on a closed store returned nil", name)
		}
	}

	m, err := db.OpenMarkerStore(filepath.Join(t.TempDir(), "erasure", "markers.sqlite"), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if err := m.Close(); err != nil { // a second close is harmless
		t.Errorf("second Close = %v", err)
	}
	var nilStore *db.MarkerStore
	if err := nilStore.Close(); err != nil {
		t.Errorf("Close on a nil store = %v", err)
	}
	markerCalls := map[string]func() error{
		"RecordPendingAccount": func() error { _, _, err := m.RecordPendingAccount(ctx, uid, 0); return err },
		"ConfirmAccount":       func() error { return m.ConfirmAccount(ctx, "t") },
		"DiscardPending":       func() error { return m.DiscardPending(ctx, "t") },
		"Markers":              func() error { _, err := m.Markers(ctx); return err },
		"RecordMessagesSweep":  func() error { return m.RecordMessagesSweep(ctx, chID, "2026-01-01 00:00:00", 0) },
		"ReplayMessages": func() error {
			_, err := m.ReplayMessages(ctx, func(context.Context, int64, string) (int, error) { return 0, nil })
			return err
		},
		"ReplayAccounts": func() error {
			_, err := m.ReplayAccounts(ctx, database, func(context.Context, int64, string) error { return nil })
			return err
		},
	}
	for name, call := range markerCalls {
		if err := call(); err == nil {
			t.Errorf("%s on a closed marker store returned nil", name)
		}
	}
	// A marker file whose directory cannot be created.
	blocked := filepath.Join(t.TempDir(), "not-a-dir")
	if err := writeFile(blocked, "x"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.OpenMarkerStore(filepath.Join(blocked, "erasure", "markers.sqlite"), make([]byte, 32)); err == nil {
		t.Error("OpenMarkerStore under a file succeeded")
	}
}

// The replay callbacks' errors surface: an erase that fails stops the
// account replay, a sweep that fails stops the messages replay.
func TestMarkerStore_ReplayPropagatesCallbackErrors(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedUser(t, database, "replay-error")
	m, err := db.OpenMarkerStore(filepath.Join(t.TempDir(), "markers.sqlite"), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	tok, _, _ := m.RecordPendingAccount(ctx, uid, 0)
	_ = m.ConfirmAccount(ctx, tok)
	_ = m.RecordMessagesSweep(ctx, 7, "2026-01-01 00:00:00", 0)
	if _, err := m.ReplayAccounts(ctx, database, func(context.Context, int64, string) error { return context.DeadlineExceeded }); err == nil {
		t.Error("ReplayAccounts swallowed the erase error")
	}
	if _, err := m.ReplayMessages(ctx, func(context.Context, int64, string) (int, error) { return 0, context.DeadlineExceeded }); err == nil {
		t.Error("ReplayMessages swallowed the sweep error")
	}
	// A messages sweep that removes nothing counts no replay.
	if n, err := m.ReplayMessages(ctx, func(context.Context, int64, string) (int, error) { return 0, nil }); err != nil || n != 0 {
		t.Errorf("idle ReplayMessages = %d, %v", n, err)
	}
	markers, _ := m.Markers(ctx)
	for _, mk := range markers {
		if mk.Replays != 0 {
			t.Errorf("an idle or failed replay was counted: %+v", mk)
		}
	}
}

func writeFile(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o600)
}
