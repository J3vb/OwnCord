package db

import (
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// MessageDeliveryClockSkew is the greatest future timestamp a delivery id may carry; a
// restore cutoff must cover it.
const MessageDeliveryClockSkew = 5 * time.Minute

// MessageDeliveryFloorMS survives database replacement: a receipt miss below it must
// never read as a new send after a restore erased newer receipts.
func (d *DB) MessageDeliveryFloorMS() int64 { return d.messageDeliveryFloor.Load() }

// AdvanceMessageDeliveryFloorForRestore must run AFTER closing the live database and
// BEFORE copying a backup over it, so no concurrently accepted id can overtake the
// cutoff. Failure aborts the copy. The sidecar is outside SQLite backups, like
// deletion markers.
func AdvanceMessageDeliveryFloorForRestore(dbPath string) error {
	return advanceMessageDeliveryFloor(dbPath, time.Now())
}

func advanceMessageDeliveryFloor(dbPath string, now time.Time) error {
	previous, err := readMessageDeliveryFloor(dbPath)
	if err != nil {
		return err
	}
	floor := max(previous, now.Add(MessageDeliveryClockSkew).UnixMilli()+1)
	path, err := messageDeliveryFloorPath(dbPath)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".message-retry-floor-*")
	if err != nil {
		return fmt.Errorf("creating message retry cutoff: %w", err)
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	if _, err := fmt.Fprintf(tmp, "%d\n", floor); err != nil {
		return fmt.Errorf("writing message retry cutoff: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("syncing message retry cutoff: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing message retry cutoff: %w", err)
	}
	if err := replaceMessageDeliveryFloor(tmp.Name(), path); err != nil {
		return fmt.Errorf("persisting message retry cutoff: %w", err)
	}
	return nil
}

// readMessageDeliveryFloor takes the higher of the cutoff beside the real database and
// one an older binary left beside a symlinked database path.
func readMessageDeliveryFloor(dbPath string) (int64, error) {
	path, err := messageDeliveryFloorPath(dbPath)
	if err != nil {
		return 0, err
	}
	floor, err := readMessageDeliveryFloorFile(path)
	if err != nil {
		return 0, err
	}
	if legacy, err := dbFilePath(dbPath); err == nil && legacy+messageDeliveryFloorSuffix != path {
		old, err := readMessageDeliveryFloorFile(legacy + messageDeliveryFloorSuffix)
		if err != nil {
			return 0, err
		}
		floor = max(floor, old)
	}
	return floor, nil
}

func readMessageDeliveryFloorFile(path string) (int64, error) {
	floor, err := parseMessageDeliveryFloorFile(path)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", path, err)
	}
	return floor, nil
}

func parseMessageDeliveryFloorFile(path string) (int64, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil // Existing installations have not restored through this gate.
	}
	if err != nil {
		return 0, fmt.Errorf("opening message retry cutoff: %w", err)
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, 32))
	if err != nil {
		return 0, fmt.Errorf("reading message retry cutoff: %w", err)
	}
	// A canonical 13-digit Unix millisecond value and one newline. Truncation,
	// oversized data and malformed values must not silently reset protection.
	if len(data) != 14 || data[13] != '\n' {
		return 0, errors.New("invalid message retry cutoff file")
	}
	floor, err := strconv.ParseInt(string(data[:13]), 10, 64)
	if err != nil || floor <= 0 || strconv.FormatInt(floor, 10) != string(data[:13]) {
		return 0, errors.New("invalid message retry cutoff value")
	}
	return floor, nil
}

const messageDeliveryFloorSuffix = ".message-retry-floor"

// messageDeliveryFloorPath sits beside the real database a symlinked path points at, where
// a restore replaces the file, so the panel and the restore CLI agree on it.
func messageDeliveryFloorPath(dbPath string) (string, error) {
	p, err := dbFilePath(dbPath)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		p = resolved
	} else {
		p = resolveDangling(p)
	}
	return p + messageDeliveryFloorSuffix, nil
}

// dbFilePath is the on-disk file behind a database path or "file:" URI, for
// the sidecar files that sit next to it.
func dbFilePath(dbPath string) (string, error) {
	if dbPath == "" || isMemoryPath(dbPath) {
		return "", errors.New("message retry cutoff requires a database file")
	}
	if strings.HasPrefix(dbPath, "file:") {
		u, err := url.Parse(dbPath)
		if err != nil || (u.Host != "" && u.Host != "localhost") {
			return "", errors.New("invalid database URI for message retry cutoff")
		}
		dbPath = u.Path
		if u.Opaque != "" {
			dbPath, err = url.PathUnescape(u.Opaque)
			if err != nil {
				return "", fmt.Errorf("decoding database URI: %w", err)
			}
		}
		if runtime.GOOS == "windows" && len(dbPath) > 2 && dbPath[0] == '/' && dbPath[2] == ':' {
			dbPath = dbPath[1:]
		}
	}
	if dbPath == "" {
		return "", errors.New("message retry cutoff requires a database path")
	}
	return filepath.FromSlash(dbPath), nil
}
