package db

// Staged boot-time restore. The admin restore handler no longer copies
// over the open database. It verifies a backup, stages a copy of it beside the
// database and writes a marker last; the next boot applies it here, under the
// process lock and before anything opens the database.
//
// The apply is a state machine keyed on which files exist, so it resumes after
// a crash at any point. Files, all beside the database file D:
//
//	D.restore-staged         the verified copy of the backup
//	D.restore-pending.json   the marker; written last, it is the commit point
//	D.restore-rollback{,-wal,-shm}   the live database moved aside
//	D.restore-result.json    the outcome, consumed by the next boot's startup
//
// Marker M, staged S, rollback R, live D:
//
//	!M, S          crash before commit: delete S
//	!M, R          the marker was removed by hand (cancel): put R back,
//	               discarding any D; a finished apply deletes R first
//	M, S, !R, *    not started: verify, move D (and sidecars) to R, S -> D
//	M, S, R, !D    crash between aside and swap: S -> D, then verify
//	M, !S, R, D    swapped: D must hash to the marker's checksum and pass
//	               integrity_check; ok keeps D, otherwise R -> D
//	M, !S, R, !D   crash mid-rollback: R -> D
//	M, !S, !R, D   swapped with no prior database: integrity check
//	M, S, R, D     inconsistent: touch nothing, return ErrRestoreInconsistent
//
// The marker's fields are labels only. Every path the apply opens is derived
// from the database path.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const (
	restoreStagedSuffix   = ".restore-staged"
	restoreMarkerSuffix   = ".restore-pending.json"
	restoreRollbackSuffix = ".restore-rollback"
	restoreResultSuffix   = ".restore-result.json"
)

// Restore outcomes written to the result file.
const (
	RestoreStatusApplied    = "applied"
	RestoreStatusRolledBack = "rolled_back"
	RestoreStatusRefused    = "refused"
)

var (
	// ErrRestoreInconsistent means the restore files are in a combination no
	// crash can produce. Nothing is touched; an operator must look.
	ErrRestoreInconsistent = errors.New("staged restore files are inconsistent")
	// ErrRestoreAlreadyStaged means a restore is already waiting for a boot.
	ErrRestoreAlreadyStaged = errors.New("a restore is already staged")
)

// StagedRestoreMarker is the commit record of a staged restore. Its fields are
// labels and a checksum; none is ever opened as a path.
type StagedRestoreMarker struct {
	Backup      string    `json:"backup"`
	SafetyCopy  string    `json:"safety_copy"`
	SHA256      string    `json:"sha256"`
	RequestedAt time.Time `json:"requested_at"`
	ActorID     int64     `json:"actor_id"`
}

// RestoreResult is what an apply left for the next startup to report.
type RestoreResult struct {
	Status    string    `json:"status"`
	Backup    string    `json:"backup"`
	ActorID   int64     `json:"actor_id,omitempty"`
	AppliedAt time.Time `json:"applied_at"`
	Error     string    `json:"error,omitempty"`
}

// Test seams. Production never changes them.
var (
	// checkSwapped verifies the database after the swap.
	checkSwapped = CheckBackupIntegrity
	// restoreStepHook is called after each named step of an apply; a non-nil
	// error aborts the apply at that point, as a crash would.
	restoreStepHook = func(string) error { return nil }
)

type restorePaths struct {
	db, staged, stagedTmp, marker, result, rollback string
}

func newRestorePaths(dbPath string) (restorePaths, error) {
	p, err := dbFilePath(dbPath)
	if err != nil {
		return restorePaths{}, err
	}
	return restorePaths{
		db:        p,
		staged:    p + restoreStagedSuffix,
		stagedTmp: p + restoreStagedSuffix + ".tmp",
		marker:    p + restoreMarkerSuffix,
		result:    p + restoreResultSuffix,
		rollback:  p + restoreRollbackSuffix,
	}, nil
}

var sqliteSidecars = [...]string{"", "-wal", "-shm"}

func fileExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// moveFile renames src over dst durably. On Windows a virus scanner or
// indexer can hold a just-closed SQLite file for a while, so the rename is
// retried with a growing delay for about ten seconds; elsewhere a failed
// rename is final.
func moveFile(src, dst string) error {
	attempts := 1
	if runtime.GOOS == "windows" {
		attempts = 14
	}
	var err error
	for attempt := range attempts {
		if err = replaceMessageDeliveryFloor(src, dst); err == nil {
			return nil
		}
		if errors.Is(err, os.ErrNotExist) || attempt == attempts-1 {
			break
		}
		time.Sleep(min(50*time.Millisecond<<attempt, time.Second))
	}
	return fmt.Errorf("moving %s to %s: %w", filepath.Base(src), filepath.Base(dst), err)
}

// moveSidecars moves each of a database's -wal and -shm files (not the main
// file) from one base name to another. A missing source is skipped.
func moveSidecars(from, to string) error {
	for _, suffix := range sqliteSidecars[1:] {
		if !fileExists(from + suffix) {
			continue
		}
		if err := moveFile(from+suffix, to+suffix); err != nil {
			return err
		}
	}
	return nil
}

func removeIfPresent(paths ...string) error {
	for _, p := range paths {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("removing %s: %w", filepath.Base(p), err)
		}
	}
	return nil
}

func removeAll(base string) error {
	return removeIfPresent(base, base+"-wal", base+"-shm")
}

// writeFileAtomic writes data to path through a temp file, fsync and rename.
func writeFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".restore-*")
	if err != nil {
		return fmt.Errorf("creating temp file: %w", err)
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	if _, err := tmp.Write(data); err != nil {
		return fmt.Errorf("writing %s: %w", filepath.Base(path), err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("syncing %s: %w", filepath.Base(path), err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing %s: %w", filepath.Base(path), err)
	}
	return moveFile(tmp.Name(), path)
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path) //nolint:gosec // G304: a sibling of the configured database path
	if err != nil {
		return "", fmt.Errorf("opening %s: %w", filepath.Base(path), err)
	}
	defer f.Close() //nolint:errcheck
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("hashing %s: %w", filepath.Base(path), err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// ApplyStagedRestore finishes a staged restore, or recovers a crashed one,
// before the database is opened. The caller must hold the process lock. With
// nothing staged it does nothing and returns the zero result. Otherwise it
// returns the outcome, which is also written to the result file for the
// next startup to report; an error means the files are left for an operator.
func ApplyStagedRestore(dbPath string) (RestoreResult, error) {
	if dbPath == "" || isMemoryPath(dbPath) {
		return RestoreResult{}, nil
	}
	p, err := newRestorePaths(dbPath)
	if err != nil {
		return RestoreResult{}, fmt.Errorf("applying staged restore: %w", err)
	}
	// Boot-time work with no caller context; bounded so a stuck check cannot hold the boot forever.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	hasMarker, hasStaged := fileExists(p.marker), fileExists(p.staged)
	hasRollback, hasDB := fileExists(p.rollback), fileExists(p.db)

	if !hasMarker {
		return RestoreResult{}, cleanUncommitted(p, hasStaged, hasRollback, hasDB)
	}
	m, err := readRestoreMarker(p.marker)
	if err != nil {
		// A torn or foreign marker cannot be trusted; leave everything.
		return RestoreResult{}, fmt.Errorf("applying staged restore: %w: %w", ErrRestoreInconsistent, err)
	}

	var res RestoreResult
	switch {
	case hasStaged && hasRollback && hasDB:
		return RestoreResult{}, fmt.Errorf("applying staged restore: %w: staged, rollback and live database all exist", ErrRestoreInconsistent)
	case hasStaged && hasRollback: // crash between aside and swap
		res, err = resumeSwap(ctx, p, m)
	case hasStaged: // not started
		res, err = startSwap(ctx, p, dbPath, m)
	case hasRollback && hasDB: // swapped
		res, err = verifySwapped(ctx, p, m)
	case hasRollback: // crash mid-rollback: the old files are still being put back
		res, err = resumeRollback(p, m)
	default:
		// No staged copy and nothing moved aside: a swap always leaves the
		// rollback file until it is finished, so this is a refusal that was
		// recorded and interrupted, or a staged copy removed by hand.
		res = priorResult(p, m)
	}
	if err != nil {
		return RestoreResult{}, err
	}
	if err := finishAndClean(p, res); err != nil {
		return RestoreResult{}, err
	}
	slog.Warn("staged restore finished", "status", res.Status, "backup", res.Backup, "error", res.Error)
	return res, nil
}

// finishAndClean records the result and drops the marker, then discards the
// staged copy of a refusal. A crash before the discard leaves a staged copy
// with no marker, which the next boot deletes as an orphan.
func finishAndClean(p restorePaths, res RestoreResult) error {
	if err := finishRestore(p, res); err != nil {
		return err
	}
	if res.Status == RestoreStatusRefused {
		return removeStaged(p)
	}
	return nil
}

func resumeRollback(p restorePaths, m StagedRestoreMarker) (RestoreResult, error) {
	if err := restoreRollbackFiles(p); err != nil {
		return RestoreResult{}, fmt.Errorf("putting the previous database back: %w", err)
	}
	return RestoreResult{Status: RestoreStatusRolledBack, Backup: m.Backup, ActorID: m.ActorID, AppliedAt: time.Now().UTC(),
		Error: "an interrupted rollback was completed; the previous database was kept"}, nil
}

// cleanUncommitted handles the cases with no marker, none of which is a
// restore in progress.
func cleanUncommitted(p restorePaths, hasStaged, hasRollback, hasDB bool) error {
	if hasStaged || fileExists(p.stagedTmp) {
		slog.Warn("ignoring an incomplete staged restore: no marker was written")
		if err := removeStaged(p); err != nil {
			return fmt.Errorf("cleaning incomplete staged restore: %w", err)
		}
	}
	if hasRollback {
		// Every finished apply deletes the moved-aside files before it removes
		// its marker, so files still here mean the marker was deleted by hand
		// (the documented way to cancel) while the swap was under way or just
		// done. The moved-aside database is the one to keep.
		slog.Warn("restore marker removed during a swap — putting the previous database back")
		if hasDB {
			if err := removeIfPresent(p.db+"-wal", p.db+"-shm", p.db); err != nil {
				return fmt.Errorf("discarding the unconfirmed restored database: %w", err)
			}
		}
		if err := restoreRollbackFiles(p); err != nil {
			return fmt.Errorf("recovering moved-aside database: %w", err)
		}
	}
	return nil
}

func removeStaged(p restorePaths) error {
	if err := removeIfPresent(p.staged, p.stagedTmp, p.staged+"-wal", p.staged+"-shm"); err != nil {
		return fmt.Errorf("discarding staged copy: %w", err)
	}
	return nil
}

// priorResult returns the result an earlier, interrupted apply already wrote
// for this marker's backup, or a refusal when there is none.
func priorResult(p restorePaths, m StagedRestoreMarker) RestoreResult {
	if data, err := os.ReadFile(p.result); err == nil { //nolint:gosec // G304: sibling of the configured database
		var prior RestoreResult
		if json.Unmarshal(data, &prior) == nil && prior.Status != "" && prior.Backup == m.Backup {
			return prior
		}
	}
	return refusedResult(m, "the staged copy is missing")
}

func readRestoreMarker(path string) (StagedRestoreMarker, error) {
	var m StagedRestoreMarker
	data, err := os.ReadFile(path) //nolint:gosec // G304: sibling of the configured database
	if err != nil {
		return m, fmt.Errorf("reading restore marker: %w", err)
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return m, fmt.Errorf("decoding restore marker: %w", err)
	}
	return m, nil
}

func refusedResult(m StagedRestoreMarker, reason string) RestoreResult {
	return RestoreResult{Status: RestoreStatusRefused, Backup: m.Backup, ActorID: m.ActorID, AppliedAt: time.Now().UTC(), Error: reason}
}

// startSwap verifies the staged copy and, if it holds, moves the live
// database aside and swaps the copy in.
func startSwap(ctx context.Context, p restorePaths, dbPath string, m StagedRestoreMarker) (RestoreResult, error) {
	// A read-only open can leave -wal/-shm beside the staged copy on any exit.
	defer func() { _ = removeIfPresent(p.staged+"-wal", p.staged+"-shm") }()
	// A refusal returns a result only; the caller records it, removes the
	// marker and only then discards the staged copy.
	if sum, err := fileSHA256(p.staged); err != nil || sum != m.SHA256 {
		reason := "the staged copy does not match its checksum"
		if err != nil {
			reason = "the staged copy could not be read"
		}
		return refusedResult(m, reason), nil
	}
	if err := CheckBackupIntegrity(ctx, p.staged); err != nil {
		return refusedResult(m, "the staged copy failed its integrity check"), nil
	}

	// The process lock is held and nothing has the database open, so the
	// floors can be taken from exactly what the live database holds now. A
	// floor that cannot be stored must not block the boot: refuse, and keep
	// the old database.
	if err := AdvanceMessageDeliveryFloorForRestore(dbPath); err != nil {
		slog.Error("staged restore refused: could not preserve the message retry cutoff", "err", err)
		return refusedResult(m, "the message retry cutoff could not be preserved"), nil
	}
	carryCtx, carryCancel := context.WithTimeout(ctx, 10*time.Second)
	err := CarryWSSeqFloorForRestore(carryCtx, dbPath)
	carryCancel()
	if errors.Is(err, ErrWSSeqFloorNotStored) {
		slog.Error("staged restore refused: could not preserve the event sequence floor", "err", err)
		return refusedResult(m, "the event sequence floor could not be preserved"), nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Warn("restore: could not carry the live ws seq floor across the restore", "err", err)
	}

	// Main file first: a leftover -wal beside a missing main file is then
	// unambiguous on resume, and is moved with its database below. With no
	// live database an empty file is parked, so a finished swap is always
	// recognisable by the rollback file and putting it back means a fresh start.
	if fileExists(p.db) {
		if err := moveFile(p.db, p.rollback); err != nil {
			return RestoreResult{}, fmt.Errorf("moving the live database aside: %w", err)
		}
	} else if err := writeFileAtomic(p.rollback, nil); err != nil {
		return RestoreResult{}, fmt.Errorf("parking an empty rollback file: %w", err)
	}
	if err := restoreStepHook("aside-main"); err != nil {
		return RestoreResult{}, err
	}
	return resumeSwap(ctx, p, m)
}

// resumeSwap moves any leftover live sidecars aside with their database, then
// renames the staged copy into place and verifies it. The main file is
// already at the rollback name, or never existed.
func resumeSwap(ctx context.Context, p restorePaths, m StagedRestoreMarker) (RestoreResult, error) {
	if err := moveSidecars(p.db, p.rollback); err != nil {
		return RestoreResult{}, fmt.Errorf("moving the live database's WAL files aside: %w", err)
	}
	if err := restoreStepHook("aside"); err != nil {
		return RestoreResult{}, err
	}
	if err := moveFile(p.staged, p.db); err != nil {
		return RestoreResult{}, fmt.Errorf("moving the staged copy into place: %w", err)
	}
	if err := restoreStepHook("swapped"); err != nil {
		return RestoreResult{}, err
	}
	return verifySwapped(ctx, p, m)
}

// verifySwapped checks the database now in place. A failure rolls back to the
// moved-aside file when there is one.
func verifySwapped(ctx context.Context, p restorePaths, m StagedRestoreMarker) (RestoreResult, error) {
	// Only the staged copy may be reported as applied (and the replaced
	// database deleted). A different file here, say an empty database some
	// tool created while the restore was interrupted, leaves everything alone.
	if sum, err := fileSHA256(p.db); err != nil || sum != m.SHA256 {
		return RestoreResult{}, fmt.Errorf("applying staged restore: %w: the live database is not the staged copy", ErrRestoreInconsistent)
	}
	if err := checkSwapped(ctx, p.db); err != nil {
		slog.Error("restored database failed its integrity check", "err", err)
		return rollBack(p, m, "the restored database failed its integrity check; the previous database was kept")
	}
	return RestoreResult{Status: RestoreStatusApplied, Backup: m.Backup, ActorID: m.ActorID, AppliedAt: time.Now().UTC()}, nil
}

func rollBack(p restorePaths, m StagedRestoreMarker, reason string) (RestoreResult, error) {
	// Sidecars first and the main file last: no main file then means the
	// restored files are gone, and a resume must not touch what it finds.
	if err := removeIfPresent(p.db+"-wal", p.db+"-shm", p.db); err != nil {
		return RestoreResult{}, fmt.Errorf("discarding the failed restore: %w", err)
	}
	if err := restoreRollbackFiles(p); err != nil {
		return RestoreResult{}, fmt.Errorf("putting the previous database back: %w", err)
	}
	return RestoreResult{Status: RestoreStatusRolledBack, Backup: m.Backup, ActorID: m.ActorID, AppliedAt: time.Now().UTC(), Error: reason}, nil
}

// restoreRollbackFiles renames the moved-aside database and sidecars back.
// The main file goes last, so a crash part-way is re-run by the same state.
func restoreRollbackFiles(p restorePaths) error {
	if err := moveSidecars(p.rollback, p.db); err != nil {
		return err
	}
	if fileExists(p.rollback) {
		return moveFile(p.rollback, p.db)
	}
	return nil
}

// finishRestore records the result, then drops the marker, then the files
// moved aside. A crash between any two leaves a state the table above reads.
func finishRestore(p restorePaths, res RestoreResult) error {
	data, err := json.Marshal(res)
	if err != nil {
		return fmt.Errorf("encoding restore result: %w", err)
	}
	if err := writeFileAtomic(p.result, data); err != nil {
		return fmt.Errorf("writing restore result: %w", err)
	}
	if err := restoreStepHook("result"); err != nil {
		return err
	}
	// The replaced database goes before the marker: with no marker, files
	// still moved aside can only mean a hand-cancelled restore (see
	// cleanUncommitted), never a finished one.
	if res.Status == RestoreStatusApplied {
		if err := removeAll(p.rollback); err != nil {
			return fmt.Errorf("removing replaced database: %w", err)
		}
		// Make the deletions durable first: a marker removal that survived a
		// power loss while a rollback file came back would read as a
		// hand-cancelled restore and discard the restored database.
		syncDir(filepath.Dir(p.marker))
	}
	if err := removeIfPresent(p.marker); err != nil {
		return fmt.Errorf("removing restore marker: %w", err)
	}
	return nil
}

// syncDir flushes a directory's entries so completed removals survive a power
// loss. Best effort: Windows cannot sync a directory, and a failure here only
// narrows the durability window the caller already tolerates.
func syncDir(dir string) {
	d, err := os.Open(dir) //nolint:gosec // G304: the configured database directory
	if err != nil {
		return
	}
	_ = d.Sync()
	_ = d.Close()
}
