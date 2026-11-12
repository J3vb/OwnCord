package db

// Backup and restore support: an online copy via VACUUM INTO, validation of a
// candidate file before it is offered or restored, and the strict path gate both rely on.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// BackupVACUUMPreExecHook runs once inside BackupToSafe when non-nil, after it
// has checked out the connection the VACUUM runs on and before the VACUUM
// executes. Test-only: it holds the backup at a known point so a test can assert
// a concurrent write completes. It guards only between the pinned Conn
// checkout and the Exec on that conn.
var BackupVACUUMPreExecHook func()

// backupPublishMu serializes the final "destination free? then rename" step: two
// same-second backups share a name, and the second rename would silently replace the
// first on Linux or fail on Windows.
var backupPublishMu syncutil.Mutex

// BackupTo creates an online backup using VACUUM INTO; the destination must not exist
// and must resolve under safeRoot. The path reaches SQLite as a bound value, never SQL
// text.
func (d *DB) BackupTo(ctx context.Context, path string) error {
	return d.BackupToSafe(ctx, path, filepath.Join("data", "backups"))
}

// BackupToSafe is BackupTo with an explicit safe root, exported for testing. It
// runs on the reader pool (VACUUM INTO only reads; holding the writer stalled
// every write for 0.4-1.3 s daily). It writes to a unique sibling ".tmp" file
// and renames it into place after the VACUUM succeeds, so a killed backup leaves
// a ".tmp" the listing and retention scans never offer, not a truncated ".db".
func (d *DB) BackupToSafe(ctx context.Context, path, safeRoot string) error {
	started := time.Now()
	clean := filepath.Clean(path)

	absRoot, err := filepath.Abs(safeRoot)
	if err != nil {
		return fmt.Errorf("BackupToSafe: resolving safe root: %w", err)
	}
	absClean, err := filepath.Abs(clean)
	if err != nil {
		return fmt.Errorf("BackupToSafe: resolving path: %w", err)
	}

	if !strings.HasPrefix(absClean, absRoot+string(filepath.Separator)) {
		return fmt.Errorf("BackupToSafe: path %q is not under safe root %q", absClean, absRoot)
	}

	// A null byte would end the name early inside SQLite, so the file written would not be
	// the one named.
	if strings.ContainsRune(absClean, 0) {
		return fmt.Errorf("BackupToSafe: path contains a null byte")
	}

	// Refuse an existing destination before the VACUUM, so a collision is reported
	// without writing a byte and a file this call did not create is never overwritten.
	if _, statErr := os.Stat(absClean); statErr == nil {
		return fmt.Errorf("BackupToSafe: destination %q already exists", absClean)
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return fmt.Errorf("BackupToSafe: checking destination %q: %w", absClean, statErr)
	}

	// Refuse before the temp exists, so a short volume gets a message naming the numbers
	// rather than a copy that fills the disk.
	if err := d.checkBackupSpace(filepath.Dir(absClean)); err != nil {
		return err
	}

	// A unique temp beside the destination: same directory keeps the rename atomic
	// and the path under safeRoot, ".tmp" keeps it out of "*.db" scans, the unique
	// name keeps same-second backups apart. VACUUM INTO accepts an existing empty file.
	tmp, err := os.CreateTemp(filepath.Dir(absClean), filepath.Base(absClean)+".*.tmp")
	if err != nil {
		return fmt.Errorf("BackupToSafe: creating temp: %w", err)
	}
	absTemp := tmp.Name()
	if err := tmp.Close(); err != nil {
		_ = os.Remove(absTemp)
		return fmt.Errorf("BackupToSafe: creating temp: %w", err)
	}

	// Under WAL the reader runs concurrently with writers. Pin one reader
	// connection for the whole call so the test hook can hold it.
	conn, err := d.reader.Conn(ctx)
	if err != nil {
		_ = os.Remove(absTemp)
		return fmt.Errorf("BackupToSafe: acquiring reader connection: %w", err)
	}
	defer conn.Close() //nolint:errcheck

	if BackupVACUUMPreExecHook != nil {
		BackupVACUUMPreExecHook()
	}

	// The destination is bound, not written into the statement; as an absolute path SQLite
	// reads it as a plain file name.
	if _, err := conn.ExecContext(ctx, "VACUUM INTO ?", absTemp); err != nil {
		_ = os.Remove(absTemp)
		return fmt.Errorf("BackupToSafe: %w", err)
	}

	// Publish under a lock with the destination re-check: a same-name backup that
	// reached its VACUUM after the pre-check must be told the destination exists.
	if err := publishBackup(absTemp, absClean); err != nil {
		_ = os.Remove(absTemp)
		return err
	}

	slog.Info("database backup written", "path", filepath.Base(absClean), "duration_ms", time.Since(started).Milliseconds())
	return nil
}

func publishBackup(absTemp, absClean string) error {
	backupPublishMu.Lock()
	defer backupPublishMu.Unlock()
	if _, statErr := os.Stat(absClean); statErr == nil {
		return fmt.Errorf("BackupToSafe: destination %q already exists", absClean)
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return fmt.Errorf("BackupToSafe: checking destination %q: %w", absClean, statErr)
	}
	if err := os.Rename(absTemp, absClean); err != nil {
		return fmt.Errorf("BackupToSafe: publishing backup: %w", err)
	}
	return nil
}

// CheckBackupIntegrity opens the SQLite file read-only and runs PRAGMA
// integrity_check, returning nil only on "ok". Use it after a backup is written and
// before it is restored.
func CheckBackupIntegrity(ctx context.Context, path string) error {
	abs, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return fmt.Errorf("CheckBackupIntegrity: resolving path: %w", err)
	}
	if _, err := os.Stat(abs); err != nil {
		return fmt.Errorf("CheckBackupIntegrity: %w", err)
	}
	conn, err := sql.Open("sqlite", readOnlyURI(abs))
	if err != nil {
		return fmt.Errorf("CheckBackupIntegrity: open: %w", err)
	}
	defer conn.Close() //nolint:errcheck
	var result string
	if err := conn.QueryRowContext(ctx, "PRAGMA integrity_check(10)").Scan(&result); err != nil {
		return fmt.Errorf("CheckBackupIntegrity: %w", err)
	}
	if result != "ok" {
		return fmt.Errorf("CheckBackupIntegrity: integrity_check reported %q", result)
	}
	return nil
}

// uriPathEscaper escapes the characters SQLite gives meaning in a file: URI
// path (% ? #); raw, "backup#2.db" would open (and create) "backup".
var uriPathEscaper = strings.NewReplacer("%", "%25", "?", "%3F", "#", "%23")

func readOnlyURI(abs string) string {
	return "file:" + uriPathEscaper.Replace(filepath.ToSlash(abs)) + "?mode=ro&_pragma=busy_timeout(2000)"
}
