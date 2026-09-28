package db_test

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
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

// TestBackupToSafe_ConcurrentWriteIsNotDelayed is PERF-10's isolating
// measurement and SRV-02's acceptance: a concurrent INSERT is not delayed by a
// running backup.
//
// A 500k-row database makes the backup take hundreds of milliseconds, so a
// single INSERT issued right after the backup starts is issued during it with
// negligible race. The assertion compares the INSERT's latency against the
// backup's own duration, not a fixed threshold: on the reader pool the INSERT
// is microseconds against a backup of hundreds of milliseconds, while on the
// old writer-based VACUUM the single writer connection is held for the backup's
// whole duration, so the INSERT queues and its latency is the backup duration.
// Comparing the two measurements keeps the test robust on a slow or fast box.
func TestBackupToSafe_ConcurrentWriteIsNotDelayed(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)
	ctx := context.Background()

	if _, err := database.ExecContext(ctx,
		`INSERT INTO roles (name, permissions, position, is_default) VALUES ('writer', 0, 0, 0)`); err != nil {
		t.Fatalf("seed role: %v", err)
	}
	// messages carries foreign keys, so the seed rows need an owner and a
	// channel first.
	if _, err := database.ExecContext(ctx,
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'bench', '', 4)`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO channels (id, name, type) VALUES (1, 'bench', 'text')`); err != nil {
		t.Fatalf("seed channel: %v", err)
	}
	// Make the database large enough that the backup is clearly the longer
	// operation. Seeded in one statement so the test setup is not the timing.
	if _, err := database.ExecContext(ctx,
		`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 400000)
		 INSERT INTO messages (channel_id, user_id, content)
		 SELECT 1, 1, 'seed ' || i || ' xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' FROM seq`); err != nil {
		t.Fatalf("seed rows: %v", err)
	}

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	backupStart := time.Now()
	done := make(chan error, 1)
	go func() {
		done <- database.BackupToSafe(ctx, filepath.Join(backupDir, "during-writes.db"), backupDir)
	}()
	// Give the backup a moment to reach its VACUUM, so the INSERT below lands
	// inside it rather than racing its start.
	time.Sleep(50 * time.Millisecond)

	insertStart := time.Now()
	if _, err := database.ExecContext(ctx,
		`INSERT INTO roles (name, permissions, position, is_default) VALUES ('during', 0, 0, 0)`); err != nil {
		t.Fatalf("INSERT during backup: %v", err)
	}
	insertLatency := time.Since(insertStart)

	backupErr := <-done
	backupDuration := time.Since(backupStart)
	if backupErr != nil {
		t.Fatalf("BackupToSafe: %v", backupErr)
	}

	// The backup must be the long pole; if it were not, the comparison below
	// would be too close to distinguish and the test would be measuring noise.
	if backupDuration < 100*time.Millisecond {
		t.Skipf("backup too fast (%v) to measure contention on this box", backupDuration)
	}
	if insertLatency > backupDuration/4 {
		t.Fatalf("INSERT during backup took %v against a backup of %v; writers are queuing behind the backup", insertLatency, backupDuration)
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
// so a second one never removes or publishes the first one's half-written
// file; whatever it reports, the published backup is a complete database.
func TestBackupToSafe_SameNameBackupsDoNotShareATemp(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	backupPath := filepath.Join(backupDir, "same-second.db")

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
	if succeeded == 0 {
		t.Fatal("neither same-second backup landed")
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
