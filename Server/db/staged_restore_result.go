package db

// The result half of a staged restore: reading and clearing the file an apply
// leaves for the next startup, and the open-time hook that runs the apply.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// ReadRestoreResult reads the result file an apply left, without removing it.
// found is false when there is none. The caller reports it, then calls
// ClearRestoreResult, so a crash in between repeats the report rather than
// losing it.
func ReadRestoreResult(dbPath string) (res RestoreResult, found bool, err error) {
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
	if err := json.Unmarshal(data, &res); err != nil {
		return RestoreResult{}, false, fmt.Errorf("decoding restore result: %w", err)
	}
	return res, true, nil
}

// ClearRestoreResult deletes the result file once it has been reported.
func ClearRestoreResult(dbPath string) error {
	if dbPath == "" || isMemoryPath(dbPath) {
		return nil
	}
	p, err := newRestorePaths(dbPath)
	if err != nil {
		return fmt.Errorf("clearing restore result: %w", err)
	}
	if err := os.Remove(p.result); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("clearing restore result: %w", err)
	}
	return nil
}

// applyOnOpen is ApplyStagedRestore behind a variable that nothing assigns
// after init. The apply owns its own bounded context because Open has none to
// hand down; a direct call (even with a nolint at the call site, which cannot
// reach the reports in Open's callers) makes contextcheck flag every Open.
var applyOnOpen = ApplyStagedRestore

// ErrRestoreInProgress means a staged restore has not finished, so only the
// server (which finishes it at start-up) may open the database.
var ErrRestoreInProgress = errors.New("a staged restore is in progress: start the server to finish it before using this database")

// prepareOpen applies any staged restore and then reads the message retry
// cutoff, so the cutoff read sees a value the apply advanced. The apply needs
// the process lock; a caller without it (short-lived tooling, or a lock the
// platform could not take) must not open the database while a restore is
// pending or half done, because opening would create a live database where
// the apply expects none.
func prepareOpen(path string, locked bool) (int64, error) {
	if locked {
		if _, err := applyOnOpen(path); err != nil {
			return 0, fmt.Errorf("applying staged restore: %w", err)
		}
	} else if restoreInProgress(path) {
		return 0, ErrRestoreInProgress
	}
	floor, err := readMessageDeliveryFloor(path)
	if err != nil {
		return 0, fmt.Errorf("loading message retry cutoff: %w", err)
	}
	return floor, nil
}

func restoreInProgress(path string) bool {
	p, err := newRestorePaths(path)
	return err == nil && (fileExists(p.marker) || fileExists(p.rollback))
}
