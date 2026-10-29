package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// The WebSocket sequence floor is also kept in a sidecar file beside the
// database, outside every backup and every restore. The copy in the settings
// table is overwritten when an admin restores a backup, which rewinds it to
// the value the backup captured; the sidecar is not, so the next boot can
// take the larger of the two and reserve its seq block above anything the
// pre-restore server handed out.

const wsSeqFloorSuffix = ".ws-seq-floor"

// WSSeqFloorSettingKey is the settings-table key the boot-time seq floor is
// persisted under; the restore paths read it from the live database.
const WSSeqFloorSettingKey = "ws_seq_floor"

// WSSeqFloorReserve is the block every boot reserves above the stored floor.
// It only has to exceed what one boot could emit before its next
// restart.
const WSSeqFloorReserve = 1_000_000_000

// MaxWSSeqFloor is the largest floor that is stored or accepted: 2^53, the
// last point where every seq is still exactly representable in a JSON number.
// A boot that would reserve past it stores MaxWSSeqFloor instead, so the floor
// saturates and is never rejected or moved down by the next boot.
const MaxWSSeqFloor uint64 = 1 << 53

// WSSeqFloorSidecar reads the sequence floor recorded beside the database.
// ok is false for an in-memory database, a missing file, or a file that does
// not hold exactly one canonical uint64 — callers fall back to the settings
// table and boot is never blocked. A damaged file is reported in err so the
// caller can log it.
func (d *DB) WSSeqFloorSidecar() (floor uint64, ok bool, err error) {
	return readWSSeqFloorFile(d.wsSeqFloorPath())
}

func readWSSeqFloorFile(path string) (floor uint64, ok bool, err error) {
	if path == "" {
		return 0, false, nil
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("opening ws seq floor: %w", err)
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, 64))
	if err != nil {
		return 0, false, fmt.Errorf("reading ws seq floor: %w", err)
	}
	text, found := strings.CutSuffix(string(data), "\n")
	parsed, perr := strconv.ParseUint(text, 10, 64)
	if !found || perr != nil || strconv.FormatUint(parsed, 10) != text || parsed > MaxWSSeqFloor {
		return 0, false, errors.New("invalid ws seq floor file")
	}
	return parsed, true, nil
}

// StoreWSSeqFloorSidecar records floor beside the database with a
// write-temp, fsync, rename sequence, so a crash leaves either the previous
// value or the new one and never a partial file. It is a no-op for an
// in-memory database.
func (d *DB) StoreWSSeqFloorSidecar(floor uint64) error {
	return writeWSSeqFloorFile(d.wsSeqFloorPath(), floor)
}

func writeWSSeqFloorFile(path string, floor uint64) error {
	if path == "" {
		return nil
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".ws-seq-floor-*")
	if err != nil {
		return fmt.Errorf("creating ws seq floor: %w", err)
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	if _, err := fmt.Fprintf(tmp, "%d\n", floor); err != nil {
		return fmt.Errorf("writing ws seq floor: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("syncing ws seq floor: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing ws seq floor: %w", err)
	}
	if err := replaceMessageDeliveryFloor(tmp.Name(), path); err != nil {
		return fmt.Errorf("persisting ws seq floor: %w", err)
	}
	return nil
}

func (d *DB) wsSeqFloorPath() string {
	base, ok := strings.CutSuffix(d.walPath, "-wal")
	if !ok || base == "" {
		return ""
	}
	return base + wsSeqFloorSuffix
}

// wsSeqFloorPathFor is the sidecar path for the database at dbPath, resolved
// the way walFilePath is so a live handle and a path-based caller agree.
func wsSeqFloorPathFor(dbPath string) string {
	p, err := dbFilePath(dbPath)
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		p = resolved
	}
	return p + wsSeqFloorSuffix
}

// ErrWSSeqFloorNotStored means CarryWSSeqFloorForRestore found a floor to keep
// but could not write it beside the database, so a restore must not go on.
var ErrWSSeqFloorNotStored = errors.New("ws seq floor sidecar not stored")

// CarryWSSeqFloorForRestore must run after the live database is closed and
// before a backup is copied over it. It folds the live settings.ws_seq_floor
// into the sidecar (keeping the larger of the two), so a restore that rewinds
// the settings row cannot make the next boot reuse a block the pre-restore
// server already handed out. This also covers an install whose sidecar has
// never been written. When the live database is missing or unreadable only
// the existing sidecar protects the next boot, and that error is for the
// caller to log. A floor that cannot be written wraps ErrWSSeqFloorNotStored,
// and the caller must refuse the restore.
func CarryWSSeqFloorForRestore(ctx context.Context, dbPath string) error {
	path := wsSeqFloorPathFor(dbPath)
	if path == "" {
		return nil
	}
	existing, _, rerr := readWSSeqFloorFile(path) // a damaged sidecar counts as 0
	live, lerr := readLiveWSSeqFloor(ctx, dbPath)
	floor := max(existing, live)
	if floor == 0 {
		return errors.Join(rerr, lerr)
	}
	if err := writeWSSeqFloorFile(path, floor); err != nil {
		return errors.Join(rerr, lerr, fmt.Errorf("%w: %w", ErrWSSeqFloorNotStored, err))
	}
	return errors.Join(rerr, lerr)
}

func readLiveWSSeqFloor(ctx context.Context, dbPath string) (uint64, error) {
	p, err := dbFilePath(dbPath)
	if err != nil {
		return 0, fmt.Errorf("resolving database file for ws seq floor: %w", err)
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return 0, fmt.Errorf("resolving database path: %w", err)
	}
	if _, err := os.Stat(abs); err != nil {
		return 0, fmt.Errorf("reading live ws seq floor: %w", err)
	}
	conn, err := sql.Open("sqlite", readOnlyURI(abs))
	if err != nil {
		return 0, fmt.Errorf("opening live database: %w", err)
	}
	defer conn.Close() //nolint:errcheck
	var raw string
	err = conn.QueryRowContext(ctx, "SELECT value FROM settings WHERE key = ?", WSSeqFloorSettingKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("reading live ws seq floor: %w", err)
	}
	v, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("live ws seq floor %q is not a valid value: %w", raw, err)
	}
	if v > MaxWSSeqFloor {
		return 0, fmt.Errorf("live ws seq floor %d is out of range", v)
	}
	return v, nil
}
