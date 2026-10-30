package db

// Backup and restore support: an online copy via VACUUM INTO, validation of a
// candidate file before it is offered or restored, and the strict path gate
// both rely on. Split out of admin_queries.go at its file-size ceiling.

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
// executes. Test-only (exported so the db-level
// TestBackupToSafe_ConcurrentWriteIsNotDelayed and the service-level
// TestReserve_NotBlockedByAConcurrentBackup can park the backup on it instead
// of sleeping): it holds the backup at a known point while it owns its pool's
// connection, so a test can assert a concurrent write completes. It guards the
// writer only between the pinned Conn checkout and the Exec on that conn; an
// unpinned d.writer.ExecContext after the hook would not be caught.
var BackupVACUUMPreExecHook func()

// backupPublishMu serializes the final "destination still free? then rename"
// step across BackupToSafe calls. Two backups started in the same second derive
// the same name and both pass the check; on Linux the second rename silently
// replaces the first, and on Windows MoveFileEx returns "Access is denied",
// failing instead of reporting "already exists". The VACUUM still runs
// concurrently; only the publish is serialized, and the re-check inside keeps
// the second caller reporting the collision.
//
// ponytail: process-global rather than keyed by destination; a stat+rename is
// microseconds and backups are ~daily, so use a per-file lock only if publish
// contention ever shows up.
var backupPublishMu syncutil.Mutex

// BackupTo creates an online backup using SQLite's VACUUM INTO; the
// destination must not already exist.
//
// VACUUM INTO takes no bind parameters, so the path is interpolated into SQL
// and guarded two ways: it must resolve under safeRoot (after filepath.Clean
// and filepath.Abs), and a single-quote, semicolon, double-dash or null byte
// in the cleaned path is rejected as defence-in-depth. The caller in
// handleBackup builds the path from a hardcoded directory and a timestamp.
func (d *DB) BackupTo(ctx context.Context, path string) error {
	return d.BackupToSafe(ctx, path, filepath.Join("data", "backups"))
}

// BackupToSafe is BackupTo with an explicit safe root directory, exported for
// testing with isolated directories.
//
// It runs on the reader pool: VACUUM INTO only reads, and holding the writer
// for its whole duration stalled every write (0.4-1.3 s daily, sends hanging).
// It writes to a unique sibling ".tmp" file and renames it into place only
// after the VACUUM succeeds, so a backup killed mid-copy leaves a ".tmp" the
// listing and retention scans never offer, not a truncated ".db". The rename
// is atomic because the temp path is on the same filesystem.
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

	// Structural guard: path must be under the safe root.
	if !strings.HasPrefix(absClean, absRoot+string(filepath.Separator)) {
		return fmt.Errorf("BackupToSafe: path %q is not under safe root %q", absClean, absRoot)
	}

	if err := validateBackupPathChars(absClean); err != nil {
		return err
	}

	// Refuse an existing destination before the VACUUM, so an operator-chosen name
	// or same-second collision is reported without writing a byte, and a file this
	// call did not create is never overwritten.
	if _, statErr := os.Stat(absClean); statErr == nil {
		return fmt.Errorf("BackupToSafe: destination %q already exists", absClean)
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return fmt.Errorf("BackupToSafe: checking destination %q: %w", absClean, statErr)
	}

	// A unique temp beside the destination: the same directory keeps the rename
	// atomic and the path under safeRoot, ".tmp" keeps it out of "*.db" scans, and
	// the unique name keeps same-second backups from sharing a file. VACUUM INTO
	// accepts an existing empty file.
	tmp, err := os.CreateTemp(filepath.Dir(absClean), filepath.Base(absClean)+".*.tmp")
	if err != nil {
		return fmt.Errorf("BackupToSafe: creating temp: %w", err)
	}
	absTemp := tmp.Name()
	if err := tmp.Close(); err != nil {
		_ = os.Remove(absTemp)
		return fmt.Errorf("BackupToSafe: creating temp: %w", err)
	}
	if err := validateBackupPathChars(absTemp); err != nil {
		_ = os.Remove(absTemp)
		return err
	}

	// Read on the reader pool: under WAL it runs concurrently with writers instead
	// of queueing behind the single writer. Pin one reader connection for the whole
	// call so the test hook below can hold the connection the VACUUM uses.
	conn, err := d.reader.Conn(ctx)
	if err != nil {
		_ = os.Remove(absTemp)
		return fmt.Errorf("BackupToSafe: acquiring reader connection: %w", err)
	}
	defer conn.Close() //nolint:errcheck

	if BackupVACUUMPreExecHook != nil {
		BackupVACUUMPreExecHook()
	}

	if _, err := conn.ExecContext(ctx, fmt.Sprintf("VACUUM INTO '%s'", absTemp)); err != nil {
		// Nothing to clean up beyond the temp VACUUM may have partly written; the
		// final path was never touched.
		_ = os.Remove(absTemp)
		return fmt.Errorf("BackupToSafe: %w", err)
	}

	// Publish under a lock with the destination re-check: a same-name backup that
	// reached its VACUUM after the pre-check must be told the destination exists,
	// not overwrite it (Linux) or fail with "Access is denied" (Windows).
	if err := publishBackup(absTemp, absClean); err != nil {
		_ = os.Remove(absTemp)
		return err
	}

	slog.Info("database backup written", "path", filepath.Base(absClean), "duration_ms", time.Since(started).Milliseconds())
	return nil
}

// publishBackup renames the finished temp onto absClean under backupPublishMu,
// re-checking that absClean is still free first. The caller removes absTemp on
// any error.
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

// validateBackupPathChars is the strict character gate BackupToSafe applies to
// the destination before it is interpolated into VACUUM INTO, split out only
// to keep the allowlist loop's branch count down.
func validateBackupPathChars(absClean string) error {
	// Defence-in-depth strict allowlist: alphanumerics, path separators, hyphen,
	// underscore, dot, space, colon and tilde; anything else could inject SQL via
	// the interpolated path.
	for _, ch := range absClean {
		switch {
		case ch >= 'a' && ch <= 'z',
			ch >= 'A' && ch <= 'Z',
			ch >= '0' && ch <= '9',
			ch == '/' || ch == '\\' || ch == '-' || ch == '_' || ch == '.' || ch == ' ' || ch == ':' || ch == '~':
			// allowed (colon for Windows drive letters, tilde for temp paths)
		default:
			return fmt.Errorf("BackupToSafe: path contains forbidden character %q", string(ch))
		}
	}

	// Reject SQL comment sequences that could break VACUUM INTO, though single
	// hyphens are allowed in filenames.
	if strings.Contains(absClean, "--") {
		return fmt.Errorf("BackupToSafe: path contains forbidden sequence %q", "--")
	}
	return nil
}

// CheckBackupIntegrity opens the SQLite file at path read-only and runs PRAGMA
// integrity_check, returning nil only when SQLite reports "ok". Use it right
// after a backup is written and again before it is restored, so a truncated or
// corrupt file is never presented or accepted as restorable. The path is
// escaped into its file: URI by readOnlyURI, so an operator-named file is the
// file that gets checked.
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
// path: % starts an escape, ? the query and # the fragment. Left raw, a path
// such as "backup#2.db" opens (and creates) "backup" instead.
var uriPathEscaper = strings.NewReplacer("%", "%25", "?", "%3F", "#", "%23")

// readOnlyURI is the read-only file: URI for the absolute path abs, used to
// verify a file before it is restored.
func readOnlyURI(abs string) string {
	return "file:" + uriPathEscaper.Replace(filepath.ToSlash(abs)) + "?mode=ro&_pragma=busy_timeout(2000)"
}
