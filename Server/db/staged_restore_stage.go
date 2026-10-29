package db

// StageRestore: the request half of a staged restore. The apply half
// is in staged_restore.go.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"
)

// StageRestore copies the verified backup at src beside the database, checks
// the copy, and writes the marker last. The live database is not touched. On
// any failure nothing is left staged. The caller restarts the server so the
// next boot applies it.
func StageRestore(ctx context.Context, dbPath, src string, m StagedRestoreMarker) error {
	p, err := newRestorePaths(dbPath)
	if err != nil {
		return fmt.Errorf("staging restore: %w", err)
	}
	if fileExists(p.marker) {
		return fmt.Errorf("staging restore: %w", ErrRestoreAlreadyStaged)
	}
	// Anything already here has no marker, so it is an orphan of a failed stage.
	if err := removeIfPresent(p.staged, p.stagedTmp); err != nil {
		return fmt.Errorf("staging restore: %w", err)
	}
	if err := stageCopy(ctx, p, src, &m); err != nil {
		_ = removeIfPresent(p.staged, p.stagedTmp, p.staged+"-wal", p.staged+"-shm")
		return fmt.Errorf("staging restore: %w", err)
	}
	if m.RequestedAt.IsZero() {
		m.RequestedAt = time.Now().UTC()
	}
	data, err := json.Marshal(m)
	if err != nil {
		_ = removeIfPresent(p.staged)
		return fmt.Errorf("staging restore: encoding marker: %w", err)
	}
	if err := writeFileAtomic(p.marker, data); err != nil {
		_ = removeIfPresent(p.staged, p.marker)
		return fmt.Errorf("staging restore: writing marker: %w", err)
	}
	return nil
}

// stageCopy writes src to the staged name via a temp file in the database's
// own directory, so the later swap is a same-volume rename, then verifies it.
func stageCopy(ctx context.Context, p restorePaths, src string, m *StagedRestoreMarker) error {
	in, err := os.Open(src) //nolint:gosec // G304: a sanitized backup path or an operator-supplied one
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}
	defer in.Close()                                                               //nolint:errcheck
	out, err := os.OpenFile(p.stagedTmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) //nolint:gosec // G304: sibling of the configured database
	if err != nil {
		return fmt.Errorf("create staged copy: %w", err)
	}
	if err := matchLiveOwner(p.db, out); err != nil {
		_ = out.Close()
		return err
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(out, h), in); err != nil {
		_ = out.Close()
		return fmt.Errorf("copy: %w", err)
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return fmt.Errorf("sync: %w", err)
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	if err := moveFile(p.stagedTmp, p.staged); err != nil {
		return err
	}
	m.SHA256 = hex.EncodeToString(h.Sum(nil))
	if err := CheckBackupIntegrity(ctx, p.staged); err != nil {
		return fmt.Errorf("staged copy failed verification: %w", err)
	}
	ahead, err := CheckBackupSchemaAhead(ctx, p.staged)
	if err != nil {
		return fmt.Errorf("staged copy schema check: %w", err)
	}
	if len(ahead) > 0 {
		return errors.New("staged copy was written by a newer server version")
	}
	// A read-only open of a WAL-mode file can leave sidecars behind.
	return removeIfPresent(p.staged+"-wal", p.staged+"-shm")
}
