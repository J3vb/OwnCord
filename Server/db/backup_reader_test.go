package db_test

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// SRV-02: a backup used to run VACUUM INTO on the single writer connection,
// so its whole duration queued behind — and blocked — every other write, once
// a day, with users seeing sends hang. These tests pin the two properties the
// fix guarantees: the backup does not need the writer, and a backup that does
// not finish leaves no file the listing would offer as restorable.

// TestBackupToSafe_RunsWhileTheWriterIsBusy is the concurrency proof for
// SRV-02. An open write transaction is the strongest writer-busy state there
// is — it holds the single writer connection — so a backup that still
// completes cannot have been waiting on the writer. Against the old
// writer-based VACUUM INTO this test hangs until its timeout: the exec queues
// behind the transaction, and every other writer waits behind it (measured at
// 0.4-1.3 s per INSERT once a day). Taking the backup off the writer is also
// what satisfies PERF-10; its service-level proof lives beside the quota
// code (TestReserve_NotBlockedByAConcurrentBackup, service/storage_quota_test.go).
func TestBackupToSafe_RunsWhileTheWriterIsBusy(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	// Hold the writer: BeginTx issues BEGIN IMMEDIATE on the single writer
	// connection, so nothing else can write until it ends.
	tx, err := database.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("BeginTx: %v", err)
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.ExecContext(context.Background(),
		`INSERT INTO roles (name, permissions, position, is_default) VALUES ('busy', 0, 0, 0)`); err != nil {
		t.Fatalf("seed inside the write transaction: %v", err)
	}

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	backupPath := filepath.Join(backupDir, "while-busy.db")

	done := make(chan error, 1)
	go func() {
		done <- database.BackupToSafe(context.Background(), backupPath, backupDir)
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("backup while the writer is busy: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("backup blocked behind the writer's open transaction; it must run on the reader pool")
	}

	if err := db.CheckBackupIntegrity(context.Background(), backupPath); err != nil {
		t.Fatalf("backup taken while the writer was busy is not restorable: %v", err)
	}
}

// TestBackupToSafe_ConcurrentWriteIsNotDelayed is PERF-10's isolating proof at
// the db layer and SRV-02's acceptance: a concurrent INSERT is not blocked
// behind a running backup.
//
// Deterministic, no seed, no sleep and no wall-clock ratio:
// db.BackupVACUUMPreExecHook parks the backup after it has checked out the
// connection its VACUUM will run on, while it provably holds that connection,
// until this test releases it. The INSERT must complete during that hold. On
// the reader pool the VACUUM holds no writer connection, so the INSERT runs;
// take the pinned VACUUM connection from the single writer instead and the
// hook is holding that writer, so the INSERT blocks here and the test fails.
// This replaces the old "INSERT latency against a quarter of the backup's
// duration" comparison, which broke under parallel package load. The caveat is
// the same as the service-level twin (TestReserve_NotBlockedByAConcurrentBackup):
// the guard binds while the hook sits between the pinned Conn checkout and the
// Exec on that same conn. A revert to an unpinned writer Exec with the hook
// before it would not be caught; that refactor is not the shape the code has.
func TestBackupToSafe_ConcurrentWriteIsNotDelayed(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)
	ctx := context.Background()

	if _, err := database.ExecContext(ctx,
		`INSERT INTO roles (name, permissions, position, is_default) VALUES ('writer', 0, 0, 0)`); err != nil {
		t.Fatalf("seed role: %v", err)
	}

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	// The seam the backup parks on: it signals reached once it holds the
	// connection its VACUUM will use, then blocks until the test releases it.
	parked := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseBackup := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(func() {
		releaseBackup()
		db.BackupVACUUMPreExecHook = nil
	})
	db.BackupVACUUMPreExecHook = func() {
		close(parked)
		<-release
	}

	done := make(chan error, 1)
	go func() {
		done <- database.BackupToSafe(ctx, filepath.Join(backupDir, "during-writes.db"), backupDir)
	}()

	select {
	case <-parked:
	case err := <-done:
		t.Fatalf("BackupToSafe returned before reaching its VACUUM: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("backup never reached its VACUUM; the test exercised nothing")
	}

	// The INSERT must complete while the backup is provably parked at its
	// VACUUM, holding the connection the VACUUM runs on.
	insertDone := make(chan error, 1)
	go func() {
		_, err := database.ExecContext(ctx,
			`INSERT INTO roles (name, permissions, position, is_default) VALUES ('during', 0, 0, 0)`)
		insertDone <- err
	}()

	select {
	case err := <-insertDone:
		if err != nil {
			t.Fatalf("INSERT during backup: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("INSERT did not complete while the backup was held at its VACUUM; writers are queuing behind the backup")
	}

	releaseBackup()
	if backupErr := <-done; backupErr != nil {
		t.Fatalf("BackupToSafe: %v", backupErr)
	}
	if err := db.CheckBackupIntegrity(ctx, filepath.Join(backupDir, "during-writes.db")); err != nil {
		t.Fatalf("the backup taken during the write is not restorable: %v", err)
	}
}

// TestBackupToSafe_FailedBackupLeavesNoCandidateFile locks the temp-name
// property: a VACUUM that fails must leave neither the final ".db" (which the
// listing and retention scans treat as history) nor a temp of its own behind.
// The temp is unique to the call, so a same-named backup's temp already in
// the directory — another backup started the same second, or one a killed
// process left — is neither published nor removed by this one.
func TestBackupToSafe_FailedBackupLeavesNoCandidateFile(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	backupPath := filepath.Join(backupDir, "never-lands.db")

	other := backupPath + ".tmp"
	if err := os.WriteFile(other, []byte("another backup's temp"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := database.BackupToSafe(ctx, backupPath, backupDir); err == nil {
		t.Fatal("BackupToSafe with a cancelled context should fail")
	}

	if _, err := os.Stat(backupPath); !os.IsNotExist(err) {
		t.Fatalf("a failed backup left the final .db behind (stat err=%v)", err)
	}
	if got, err := os.ReadFile(other); err != nil || string(got) != "another backup's temp" {
		t.Fatalf("a failed backup touched another backup's temp: %q, %v", got, err)
	}
	if temps := backupTemps(t, backupDir); len(temps) != 1 {
		t.Fatalf("a failed backup left its own temp behind: %v", temps)
	}
}

// TestBackupToSafe_SameNameBackupsDoNotShareATemp: two backups started in the
// same second derive the same final name. Each must VACUUM into its own temp,
// and publishing the second must be serialized against the first so exactly
// one lands: without that, on Windows both calls pass the pre-check, both
// VACUUM into distinct temps, and then both rename onto the one target —
// MoveFileEx(REPLACE_EXISTING) returns "Access is denied" when two renames
// hit the same destination at once, so the losing backup fails on a rename
// error instead of the "already exists" it should report, and Windows may
// even publish two files over each other.
//
// A barrier installed at db.BackupVACUUMPreExecHook, which runs after the
// destination pre-check, holds both calls until both have passed it, so the
// race is deterministic rather than scheduler-dependent.
func TestBackupToSafe_SameNameBackupsDoNotShareATemp(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	backupPath := filepath.Join(backupDir, "same-second.db")

	// Both goroutines must reach this point before either proceeds: each
	// signals its arrival and waits for the other, so both have passed the
	// destination pre-check before either can publish.
	var bothChecked sync.WaitGroup
	bothChecked.Add(2)
	db.BackupVACUUMPreExecHook = func() {
		bothChecked.Done()
		bothChecked.Wait()
	}
	t.Cleanup(func() { db.BackupVACUUMPreExecHook = nil })

	errs := make(chan error, 2)
	for range 2 {
		go func() { errs <- database.BackupToSafe(context.Background(), backupPath, backupDir) }()
	}
	succeeded := 0
	for range 2 {
		if err := <-errs; err == nil {
			succeeded++
		} else if !strings.Contains(err.Error(), "already exists") {
			t.Fatalf("a same-second backup failed other than on the existing destination: %v", err)
		}
	}
	if succeeded != 1 {
		t.Fatalf("same-name backups landed %d files, want exactly 1", succeeded)
	}
	if err := db.CheckBackupIntegrity(context.Background(), backupPath); err != nil {
		t.Fatalf("the published backup is not a complete database: %v", err)
	}
	if temps := backupTemps(t, backupDir); len(temps) != 0 {
		t.Fatalf("temps survived the backups: %v", temps)
	}
}

func backupTemps(t *testing.T, dir string) []string {
	t.Helper()
	temps, err := filepath.Glob(filepath.Join(dir, "*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	return temps
}

// TestBackupToSafe_LogsDuration: the acceptance requires the log line to carry
// a duration, so an operator can see how long the backup took (and notice it
// growing). It also confirms no ".tmp" survives a successful backup.
func TestBackupToSafe_LogsDuration(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	defer slog.SetDefault(prev)

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	backupPath := filepath.Join(backupDir, "timed.db")
	if err := database.BackupToSafe(context.Background(), backupPath, backupDir); err != nil {
		t.Fatalf("BackupToSafe: %v", err)
	}

	out := buf.String()
	if !strings.Contains(out, "database backup written") {
		t.Fatalf("expected a backup-written log line, got: %s", out)
	}
	if !strings.Contains(out, "duration_ms=") {
		t.Fatalf("backup log line has no duration: %s", out)
	}
	if temps := backupTemps(t, backupDir); len(temps) != 0 {
		t.Fatalf("a .tmp file survived a successful backup: %v", temps)
	}
	if _, err := os.Stat(backupPath); err != nil {
		t.Fatalf("the published backup is missing: %v", err)
	}
}
