package db

// Staged boot-time restore. The admin handler verifies a backup, stages a copy
// beside the database and writes a marker last; the next boot applies it here,
// under the process lock before anything opens the database. The apply is a
// state machine keyed on which files exist, so it resumes after a crash at any
// point. Files, all beside the database file D:
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
// The marker's fields are labels only; every path is derived from the database path.

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

const (
	RestoreStatusApplied    = "applied"
	RestoreStatusRolledBack = "rolled_back"
	RestoreStatusRefused    = "refused"
)

var (
	// ErrRestoreInconsistent means the restore files are in a combination no crash can produce;
	// nothing is touched.
	ErrRestoreInconsistent = errors.New("staged restore files are inconsistent")
	// ErrRestoreAlreadyStaged means a restore is already waiting for a boot.
	ErrRestoreAlreadyStaged = errors.New("a restore is already staged")
)

// StagedRestoreMarker is the commit record of a staged restore; none of its fields is opened as a path.
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

var (
	checkSwapped    = CheckBackupIntegrity
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
	p = restoreBase(p)
	return restorePaths{
		db:        p,
		staged:    p + restoreStagedSuffix,
		stagedTmp: p + restoreStagedSuffix + ".tmp",
		marker:    p + restoreMarkerSuffix,
		result:    p + restoreResultSuffix,
		rollback:  p + restoreRollbackSuffix,
	}, nil
}

// restoreBase is the file every restore file sits beside. A symlinked database path resolves to its
// target, so the swap replaces the real file (SQLite keeps the WAL there too) and the link survives.
// A restore that an older binary staged or half applied beside the link itself is still finished there.
func restoreBase(p string) string {
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		real = resolveDangling(p)
	}
	if real == p {
		return p
	}
	if !restoreFilesExist(real) && restoreFilesExist(p) {
		return p
	}
	return real
}

func restoreFilesExist(base string) bool {
	return fileExists(base+restoreMarkerSuffix) || fileExists(base+restoreStagedSuffix) ||
		fileExists(base+restoreStagedSuffix+".tmp") || fileExists(base+restoreRollbackSuffix)
}

// resolveDangling follows a symlink chain whose final target is missing, as it is between the live
// file being moved aside and the staged copy taking its place. It returns p unchanged when p is not
// a link, the chain is too long, or the target's directory cannot be resolved.
func resolveDangling(p string) string {
	cur := p
	for range 40 {
		fi, err := os.Lstat(cur)
		if err != nil || fi.Mode()&os.ModeSymlink == 0 {
			if cur == p {
				return p
			}
			dir, derr := filepath.EvalSymlinks(filepath.Dir(cur))
			if derr != nil {
				return p
			}
			return filepath.Join(dir, filepath.Base(cur))
		}
		target, err := os.Readlink(cur)
		if err != nil {
			return p
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(cur), target)
		}
		cur = target
	}
	return p
}

var sqliteSidecars = [...]string{"", "-wal", "-shm"}

func fileExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// moveFile renames src over dst durably. On Windows a scanner or indexer can
// hold a just-closed SQLite file, so the rename retries with growing delay for ~10s.
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

// ApplyStagedRestore finishes a staged restore, or recovers a crashed one, before the
// database is opened; the caller must hold the process lock. With nothing staged it
// returns the zero result. The outcome is also written to the result file; an error
// leaves the files for an operator.
func ApplyStagedRestore(dbPath string) (RestoreResult, error) {
	if dbPath == "" || isMemoryPath(dbPath) {
		return RestoreResult{}, nil
	}
	p, err := newRestorePaths(dbPath)
	if err != nil {
		return RestoreResult{}, fmt.Errorf("applying staged restore: %w", err)
	}
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
		// No staged copy and nothing moved aside: a swap always leaves the rollback
		// file until finished, so this is an interrupted recorded refusal or a hand-removed copy.
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

// finishAndClean records the result, drops the marker, then discards a refusal's
// staged copy; a crash before the discard leaves an orphan the next boot deletes.
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

func cleanUncommitted(p restorePaths, hasStaged, hasRollback, hasDB bool) error {
	if hasStaged || fileExists(p.stagedTmp) {
		slog.Warn("ignoring an incomplete staged restore: no marker was written")
		if err := removeStaged(p); err != nil {
			return fmt.Errorf("cleaning incomplete staged restore: %w", err)
		}
	}
	if hasRollback {
		// Every finished apply deletes the moved-aside files before removing its
		// marker, so files still here mean the marker was hand-deleted (the documented
		// cancel) mid-swap. The moved-aside database is the one to keep.
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

func startSwap(ctx context.Context, p restorePaths, dbPath string, m StagedRestoreMarker) (RestoreResult, error) {
	defer func() { _ = removeIfPresent(p.staged+"-wal", p.staged+"-shm") }()
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

	// The process lock is held and nothing has the database open, so the floors come from exactly what
	// the live database holds. A floor that cannot be stored must not block the boot: refuse and keep
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
	// unambiguous on resume. With no live database an empty file is parked, so a
	// finished swap is always recognisable by the rollback file.
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

// resumeSwap moves leftover live sidecars aside with their database, then
// renames the staged copy into place and verifies it.
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

func verifySwapped(ctx context.Context, p restorePaths, m StagedRestoreMarker) (RestoreResult, error) {
	// Only the staged copy may be reported applied (and the replaced database
	// deleted); a different file, e.g. an empty database a tool created meanwhile, leaves everything alone.
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
	// Sidecars first, main file last: no main file means the restored files are gone and a resume must
	// not touch what it finds.
	if err := removeIfPresent(p.db+"-wal", p.db+"-shm", p.db); err != nil {
		return RestoreResult{}, fmt.Errorf("discarding the failed restore: %w", err)
	}
	if err := restoreRollbackFiles(p); err != nil {
		return RestoreResult{}, fmt.Errorf("putting the previous database back: %w", err)
	}
	return RestoreResult{Status: RestoreStatusRolledBack, Backup: m.Backup, ActorID: m.ActorID, AppliedAt: time.Now().UTC(), Error: reason}, nil
}

// restoreRollbackFiles renames the moved-aside files back, main file last so a crash part-way
// re-runs from the same state.
func restoreRollbackFiles(p restorePaths) error {
	if err := moveSidecars(p.rollback, p.db); err != nil {
		return err
	}
	if fileExists(p.rollback) {
		return moveFile(p.rollback, p.db)
	}
	return nil
}

// finishRestore records the result, then drops the marker, then the moved-aside files; a crash
// between any two leaves a state the table reads.
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
	// The replaced database goes before the marker: with no marker, files still moved aside can only
	// mean a hand-cancelled restore.
	if res.Status == RestoreStatusApplied {
		if err := removeAll(p.rollback); err != nil {
			return fmt.Errorf("removing replaced database: %w", err)
		}
		// Make the deletions durable first: a marker removal that survived a power
		// loss while a rollback file came back would read as a hand-cancelled restore
		// and discard the restored database.
		syncDir(filepath.Dir(p.marker))
	}
	if err := removeIfPresent(p.marker); err != nil {
		return fmt.Errorf("removing restore marker: %w", err)
	}
	return nil
}

// syncDir flushes a directory's entries so removals survive power loss; best effort (Windows
// cannot sync a directory).
func syncDir(dir string) {
	d, err := os.Open(dir) //nolint:gosec // G304: the configured database directory
	if err != nil {
		return
	}
	_ = d.Sync()
	_ = d.Close()
}
