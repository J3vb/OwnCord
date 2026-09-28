package db

// Backup and restore support: creating an online copy of the database with
// SQLite's VACUUM INTO, validating a candidate file before it is offered or
// restored, and the strict path gate both rely on. Split out of
// admin_queries.go, which sits at its grandfathered file-size ceiling.

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
// executes. Test-only (always nil in production; exported because the
// service-level proof that Reserve is not blocked by a backup, SRV-02/PERF-10,
// drives this through UploadService.Reserve rather than calling
// db.BackupToSafe directly): it parks the backup at a known point while it
// provably owns its pool's connection, so a test can assert Reserve completes
// without a timing-ratio sleep. It guards the writer only while it sits between
// the pinned Conn checkout and the Exec on that same conn: moving that pinned
// conn to the writer makes Reserve block here, but an unpinned
// d.writer.ExecContext after the hook would not. Whether a running VACUUM
// delays a write at the SQLite lock level is covered separately by
// TestBackupToSafe_ConcurrentWriteIsNotDelayed.
var BackupVACUUMPreExecHook func()

// backupPublishMu serializes the final "destination still free? → rename" step
// across every BackupToSafe call in the process. The rename itself is atomic,
// but the pre-check and the rename are not one operation: two backups started
// in the same second derive the same final name, both pass the check, and both
// call os.Rename onto that one path. On Linux the second silently replaces the
// first; on Windows os.Rename is MoveFileEx(REPLACE_EXISTING), which returns
// "Access is denied" when two renames share a destination — the losing backup
// then failed on a rename error instead of the "already exists" it should
// report. The VACUUM still runs concurrently outside the lock; only the
// publish needs serializing, and the re-check inside it keeps the second caller
// reporting the collision rather than overwriting.
//
// ponytail: process-global rather than keyed by destination; a stat+rename is
// microseconds and backups are ~daily, so use a per-file lock only if publish
// contention ever shows up.
var backupPublishMu syncutil.Mutex

// BackupTo creates an online backup of the database using SQLite's VACUUM INTO.
// The destination path must not already exist.
//
// Security: VACUUM INTO does not support bind parameters, so the path is
// interpolated into SQL. To prevent injection we enforce two structural guards:
//  1. The path must resolve to a location under safeRoot (after filepath.Clean
//     and filepath.Abs).
//  2. After structural validation, any single-quote, semicolon, double-dash,
//     or null byte in the cleaned path causes rejection as defence-in-depth.
//
// The caller in handleBackup constructs the path from a hardcoded directory
// and a timestamp — no user input reaches this function.
func (d *DB) BackupTo(ctx context.Context, path string) error {
	return d.BackupToSafe(ctx, path, filepath.Join("data", "backups"))
}

// BackupToSafe is the internal implementation that accepts an explicit safe
// root directory. Exported for testing with isolated directories.
//
// It runs on the READER pool, not the single writer: VACUUM INTO only reads,
// and holding the writer for its whole duration stalled every other write —
// measured at 0.4-1.3 s, once a day, with users seeing sends hang. It writes
// to a unique sibling ".tmp" file and renames it into place only after the
// VACUUM succeeds, so a backup killed mid-copy (ENOSPC, EIO, a canceled ctx, the
// process dying) leaves a ".tmp" file the backup listing and retention scans
// never offer as restorable, rather than a truncated ".db" (OC-0212). The
// rename is atomic on the same filesystem, which the temp path guarantees.
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

	// Structural guard: path must be under the safe root directory.
	if !strings.HasPrefix(absClean, absRoot+string(filepath.Separator)) {
		return fmt.Errorf("BackupToSafe: path %q is not under safe root %q", absClean, absRoot)
	}

	if err := validateBackupPathChars(absClean); err != nil {
		return err
	}

	// Refuse an existing destination up front, before the VACUUM runs, so an
	// operator-chosen name or a same-second timestamp collision is reported
	// without ever writing a byte — and never overwrites a file this call did
	// not create.
	if _, statErr := os.Stat(absClean); statErr == nil {
		return fmt.Errorf("BackupToSafe: destination %q already exists", absClean)
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return fmt.Errorf("BackupToSafe: checking destination %q: %w", absClean, statErr)
	}

	// A unique temp beside the destination: the same directory keeps the
	// rename atomic and the path under safeRoot, the ".tmp" suffix keeps it
	// out of every "*.db" scan, and the unique name keeps two backups started
	// in the same second from writing into one file. VACUUM INTO accepts an
	// existing empty file as its destination.
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

	// Read on the reader pool: under WAL it runs concurrently with writers, so
	// the VACUUM's whole duration no longer queues behind — or blocks — the
	// single writer. Pin one reader connection for the whole call so the
	// test hook below (BackupVACUUMPreExecHook) can hold the very connection
	// the VACUUM uses.
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
		// Nothing to clean up beyond the temp VACUUM may have partially
		// written; the final path was never touched.
		_ = os.Remove(absTemp)
		return fmt.Errorf("BackupToSafe: %w", err)
	}

	// Publish under a lock with the destination re-check: a same-name backup
	// that reached its VACUUM after this call's pre-check must be told the
	// destination exists, not overwrite it (Linux) or fail the rename with
	// "Access is denied" (Windows).
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
// the destination before it is interpolated into VACUUM INTO. It is a separate
// function only so the allowlist loop's branch count does not dominate its
// caller; the rules and the messages are unchanged.
func validateBackupPathChars(absClean string) error {
	// Defence-in-depth: only allow safe characters (alphanumeric, path separators,
	// hyphen, underscore, dot, space, colon, tilde). This is a strict allowlist —
	// anything else is rejected to prevent SQL injection via the interpolated path.
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

	// Reject SQL comment sequences that could break the VACUUM INTO statement,
	// even though individual hyphens are allowed for filenames.
	if strings.Contains(absClean, "--") {
		return fmt.Errorf("BackupToSafe: path contains forbidden sequence %q", "--")
	}
	return nil
}

// CheckBackupIntegrity opens the SQLite file at path read-only and runs
// PRAGMA integrity_check against it. It returns nil only when SQLite reports
// "ok". Use it to verify a backup right after it is written and again before
// it is restored over the live database — a truncated or corrupt file must
// never be presented (or accepted) as restorable.
//
// The path travels into a file: URI, so it is restricted with the same
// character allowlist BackupToSafe enforces; callers always pass paths that
// already passed that gate.
func CheckBackupIntegrity(ctx context.Context, path string) error {
	abs, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return fmt.Errorf("CheckBackupIntegrity: resolving path: %w", err)
	}
	if _, err := os.Stat(abs); err != nil {
		return fmt.Errorf("CheckBackupIntegrity: %w", err)
	}
	conn, err := sql.Open("sqlite", "file:"+filepath.ToSlash(abs)+"?mode=ro&_pragma=busy_timeout(2000)")
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
