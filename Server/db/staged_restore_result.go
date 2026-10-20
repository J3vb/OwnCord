package db

// The result half of a staged restore: reading and clearing the file an apply
// leaves for the next startup, and the open-time hook that runs the apply.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
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

// TakeRestoreResult reads and then clears the result, for callers that have
// nothing to do between the two.
func TakeRestoreResult(dbPath string) (res RestoreResult, found bool, err error) {
	res, found, err = ReadRestoreResult(dbPath)
	if cerr := ClearRestoreResult(dbPath); cerr != nil {
		slog.Warn("could not remove the restore result file", "path", dbPath, "error", cerr)
	}
	return res, found, err
}

// applyOnOpen is ApplyStagedRestore, called through a variable: the apply
// owns its own bounded context because Open has none to hand down, and a
// direct call would make every Open look like a context-dropping call chain.
var applyOnOpen = ApplyStagedRestore

// prepareOpen applies any staged restore (only for a caller that holds the
// process lock: short-lived tooling never applies one) and then reads the
// message retry cutoff, so the cutoff read sees a value the apply advanced.
func prepareOpen(path string, takeLock bool) (int64, error) {
	if takeLock {
		if _, err := applyOnOpen(path); err != nil {
			return 0, fmt.Errorf("applying staged restore: %w", err)
		}
	}
	floor, err := readMessageDeliveryFloor(path)
	if err != nil {
		return 0, fmt.Errorf("loading message retry cutoff: %w", err)
	}
	return floor, nil
}
