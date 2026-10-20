package db

// Staged boot-time restore (WP 5.5). The admin restore handler no longer copies
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
//	!M, !D, R      the marker was removed mid-swap by hand: put R back
//	!M, D, R       the last apply finished: delete the stale R
//	M, S, !R, *    not started: verify, move D (and sidecars) to R, S -> D
//	M, S, R, !D    crash between aside and swap: S -> D, then verify
//	M, !S, R, D    swapped: integrity check; ok keeps D, otherwise R -> D
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

// moveFile renames src over dst durably, retrying briefly: on Windows a
// virus scanner or indexer can hold a just-closed SQLite file for a moment.
func moveFile(src, dst string) error {
	var err error
	for attempt := range 5 {
		if err = replaceMessageDeliveryFloor(src, dst); err == nil {
			return nil
		}
		if errors.Is(err, os.ErrNotExist) {
			break
		}
		time.Sleep(time.Duration(attempt+1) * 20 * time.Millisecond)
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
	case hasRollback: // crash mid-rollback
		res, err = rollBack(p, m, "an interrupted rollback was completed")
	case hasDB: // swapped onto a missing database
		res, err = verifySwapped(ctx, p, m)
	default:
		res = refusedResult(m, "the staged copy is missing")
	}
	if err != nil {
		return RestoreResult{}, err
	}
	if err := finishRestore(p, res); err != nil {
		return RestoreResult{}, err
	}
	slog.Warn("staged restore finished", "status", res.Status, "backup", res.Backup, "error", res.Error)
	return res, nil
}

// cleanUncommitted handles the cases with no marker, none of which is a
// restore in progress.
func cleanUncommitted(p restorePaths, hasStaged, hasRollback, hasDB bool) error {
	if hasStaged || fileExists(p.stagedTmp) {
		slog.Warn("ignoring an incomplete staged restore: no marker was written")
		if err := removeIfPresent(p.staged, p.stagedTmp, p.staged+"-wal", p.staged+"-shm"); err != nil {
			return fmt.Errorf("cleaning incomplete staged restore: %w", err)
		}
	}
	switch {
	case hasRollback && hasDB:
		// The previous apply removed its marker and was killed before it
		// deleted the files it had moved aside.
		if err := removeAll(p.rollback); err != nil {
			return fmt.Errorf("cleaning stale restore rollback: %w", err)
		}
	case hasRollback:
		// The marker vanished mid-swap; the moved-aside file is the database.
		if err := restoreRollbackFiles(p); err != nil {
			return fmt.Errorf("recovering moved-aside database: %w", err)
		}
	}
	return nil
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
	if sum, err := fileSHA256(p.staged); err != nil || sum != m.SHA256 {
		reason := "the staged copy does not match its checksum"
		if err != nil {
			reason = "the staged copy could not be read"
		}
		if rmErr := removeIfPresent(p.staged); rmErr != nil {
			return RestoreResult{}, fmt.Errorf("discarding staged copy: %w", rmErr)
		}
		return refusedResult(m, reason), nil
	}
	if err := CheckBackupIntegrity(ctx, p.staged); err != nil {
		if rmErr := removeIfPresent(p.staged, p.staged+"-wal", p.staged+"-shm"); rmErr != nil {
			return RestoreResult{}, fmt.Errorf("discarding staged copy: %w", rmErr)
		}
		return refusedResult(m, "the staged copy failed its integrity check"), nil
	}

	// The process lock is held and nothing has the database open, so the
	// floors can be taken from exactly what the live database holds now.
	if err := AdvanceMessageDeliveryFloorForRestore(dbPath); err != nil {
		return RestoreResult{}, fmt.Errorf("preserving message retry cutoff: %w", err)
	}
	carryCtx, carryCancel := context.WithTimeout(ctx, 10*time.Second)
	err := CarryWSSeqFloorForRestore(carryCtx, dbPath)
	carryCancel()
	if errors.Is(err, ErrWSSeqFloorNotStored) {
		return RestoreResult{}, fmt.Errorf("preserving event sequence floor: %w", err)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Warn("restore: could not carry the live ws seq floor across the restore", "err", err)
	}

	// Main file first: a leftover -wal beside a missing main file is then
	// unambiguous on resume, and is moved with its database below.
	if fileExists(p.db) {
		if err := moveFile(p.db, p.rollback); err != nil {
			return RestoreResult{}, fmt.Errorf("moving the live database aside: %w", err)
		}
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
	if err := checkSwapped(ctx, p.db); err != nil {
		slog.Error("restored database failed its integrity check", "err", err)
		if !fileExists(p.rollback) {
			return refusedResult(m, "the restored database failed its integrity check and there was no previous database to put back"), nil
		}
		return rollBack(p, m, "the restored database failed its integrity check; the previous database was kept")
	}
	return RestoreResult{Status: RestoreStatusApplied, Backup: m.Backup, ActorID: m.ActorID, AppliedAt: time.Now().UTC()}, nil
}

func rollBack(p restorePaths, m StagedRestoreMarker, reason string) (RestoreResult, error) {
	if err := removeAll(p.db); err != nil {
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
	if err := removeIfPresent(p.marker); err != nil {
		return fmt.Errorf("removing restore marker: %w", err)
	}
	if res.Status == RestoreStatusApplied {
		if err := removeAll(p.rollback); err != nil {
			return fmt.Errorf("removing replaced database: %w", err)
		}
	}
	return nil
}

// TakeRestoreResult reads the result file an apply left, then deletes it, so a
// result is reported by one boot only. found is false when there is none. An
// unreadable file is deleted too and reported in err.
func TakeRestoreResult(dbPath string) (res RestoreResult, found bool, err error) {
	if dbPath == "" || isMemoryPath(dbPath) {
		return RestoreResult{}, false, nil
	}
	p, err := newRestorePaths(dbPath)
	if err != nil {
		return RestoreResult{}, false, fmt.Errorf("reading restore result: %w", err)
	}
	data, err := os.ReadFile(p.result) //nolint:gosec // G304: sibling of the configured database
	if errors.Is(err, os.ErrNotExist) {
		return RestoreResult{}, false, nil
	}
	if err != nil {
		return RestoreResult{}, false, fmt.Errorf("reading restore result: %w", err)
	}
	if rmErr := os.Remove(p.result); rmErr != nil {
		slog.Warn("could not remove the restore result file", "path", p.result, "error", rmErr)
	}
	if err := json.Unmarshal(data, &res); err != nil {
		return RestoreResult{}, false, fmt.Errorf("decoding restore result: %w", err)
	}
	return res, true, nil
}

// prepareOpen applies any staged restore (only for a caller that holds the
// process lock: short-lived tooling never applies one) and then reads the
// message retry cutoff, so the cutoff read sees a value the apply advanced.
func prepareOpen(path string, takeLock bool) (int64, error) {
	if takeLock {
		if _, err := ApplyStagedRestore(path); err != nil {
			return 0, fmt.Errorf("applying staged restore: %w", err)
		}
	}
	return readMessageDeliveryFloor(path)
}
