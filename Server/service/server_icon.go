package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image/png"
	"os"
	"path/filepath"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
)

// The owner-uploaded server icon: one PNG in the data directory plus a short content hash in the server_icon
// settings row. The hash is what clients compare, so it changes exactly when the picture does.
const (
	// ServerIconKey is the settings row holding the icon's content hash ("" when none).
	ServerIconKey = "server_icon"
	// ServerIconFile is the icon's file name inside the data directory.
	ServerIconFile = "server-icon.png"
	// ServerIconMaxBytes bounds an upload; 256x256 art fits many times over.
	ServerIconMaxBytes = 64 << 10
	// ServerIconMinPx and ServerIconMaxPx bound the (square) side length.
	ServerIconMinPx   = 32
	ServerIconMaxPx   = 256
	serverIconHashLen = 16
)

// ErrNoServerIcon reports that the server has no icon (none set, or its file is gone).
var ErrNoServerIcon = errors.New("no server icon")

// ErrServerIconUnavailable reports a server built without a data directory for the icon (a test double).
var ErrServerIconUnavailable = errors.New("server icon storage unavailable")

// SetServerIconDir installs the directory the icon file lives in; the composition root calls it once, before
// the server takes requests.
func (s *SettingsService) SetServerIconDir(dir string) {
	s.iconDir = dir
}

func (s *SettingsService) iconPath() (string, error) {
	if s.iconDir == "" {
		return "", ErrServerIconUnavailable
	}
	return filepath.Join(s.iconDir, ServerIconFile), nil
}

// ServerIconHashOf is the short content hash clients compare: the first 16 hex characters of the SHA-256.
func ServerIconHashOf(pngBytes []byte) string {
	sum := sha256.Sum256(pngBytes)
	return hex.EncodeToString(sum[:])[:serverIconHashLen]
}

// ValidateServerIcon checks an upload: a PNG that decodes, square, between 32 and 256 px a side, at most
// 64 KiB. Failures wrap ErrBadRequest.
func ValidateServerIcon(data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("server icon is empty%.0w", ErrBadRequest)
	}
	if len(data) > ServerIconMaxBytes {
		return fmt.Errorf("server icon must be at most %d KiB%.0w", ServerIconMaxBytes>>10, ErrBadRequest)
	}
	// The header first: a tiny file can declare a huge canvas, and the full decode must never see one.
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("server icon must be a PNG image%.0w", ErrBadRequest)
	}
	if cfg.Width != cfg.Height {
		return fmt.Errorf("server icon must be square%.0w", ErrBadRequest)
	}
	if cfg.Width < ServerIconMinPx || cfg.Width > ServerIconMaxPx {
		return fmt.Errorf("server icon must be between %d and %d pixels wide%.0w", ServerIconMinPx, ServerIconMaxPx, ErrBadRequest)
	}
	if _, err := png.Decode(bytes.NewReader(data)); err != nil {
		return fmt.Errorf("server icon must be a PNG image%.0w", ErrBadRequest)
	}
	return nil
}

// SetServerIcon validates and stores a new icon and returns its hash. The file is written to a temp file in
// the data directory, synced and renamed into place; the hash row is saved only after the rename succeeds, so
// a failure at any step leaves the previous icon and hash.
func (s *SettingsService) SetServerIcon(ctx context.Context, actorID int64, data []byte) (string, error) {
	if err := ValidateServerIcon(data); err != nil {
		return "", err
	}
	path, err := s.iconPath()
	if err != nil {
		return "", err
	}
	s.iconMu.Lock()
	defer s.iconMu.Unlock()
	if err := writeFileAtomic(path, data, s.iconRename); err != nil {
		return "", fmt.Errorf("SetServerIcon: %w", err)
	}
	hash := ServerIconHashOf(data)
	if err := s.st.ApplySettings(ctx, map[string]string{ServerIconKey: hash}); err != nil {
		return "", fmt.Errorf("SetServerIcon: %w", err)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "setting_change", "setting", 0, ServerIconKey+" updated")
	return hash, nil
}

// ClearServerIcon removes the icon. The row is cleared first, so a file that cannot be removed is never
// served; a missing file is not an error.
func (s *SettingsService) ClearServerIcon(ctx context.Context, actorID int64) error {
	path, err := s.iconPath()
	if err != nil {
		return err
	}
	s.iconMu.Lock()
	defer s.iconMu.Unlock()
	if err := s.st.ApplySettings(ctx, map[string]string{ServerIconKey: ""}); err != nil {
		return fmt.Errorf("ClearServerIcon: %w", err)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("ClearServerIcon: %w", err)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "setting_change", "setting", 0, ServerIconKey+" removed")
	return nil
}

// ServerIconHash is the stored hash, "" when there is no icon or its file is missing (a database restored
// without its data directory), so a client is never pointed at a picture that is not there.
func (s *SettingsService) ServerIconHash(ctx context.Context) (string, error) {
	path, err := s.iconPath()
	if err != nil {
		// No icon storage means no icon.
		return "", nil
	}
	hash, err := s.st.GetSetting(ctx, ServerIconKey)
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return "", nil
		}
		return "", fmt.Errorf("ServerIconHash: %w", err)
	}
	hash = strings.TrimSpace(hash)
	if hash == "" {
		return "", nil
	}
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", fmt.Errorf("ServerIconHash: %w", err)
	}
	return hash, nil
}

// ServerIcon returns the icon bytes and their hash, or ErrNoServerIcon. The hash is computed from the bytes
// read, so the pair is consistent even against a concurrent replacement.
func (s *SettingsService) ServerIcon(ctx context.Context) ([]byte, string, error) {
	hash, err := s.ServerIconHash(ctx)
	if err != nil {
		return nil, "", err
	}
	if hash == "" {
		return nil, "", ErrNoServerIcon
	}
	path, err := s.iconPath()
	if err != nil {
		return nil, "", err
	}
	data, err := os.ReadFile(path) //nolint:gosec // G304: the path is <data_dir>/server-icon.png, not input
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, "", ErrNoServerIcon
		}
		return nil, "", fmt.Errorf("ServerIcon: %w", err)
	}
	return data, ServerIconHashOf(data), nil
}

// writeFileAtomic writes data to path through a synced temp file in the same directory and a rename, so a
// crash leaves either the old file or the new one, never half of one. rename is os.Rename when nil.
func writeFileAtomic(path string, data []byte, rename func(oldpath, newpath string) error) error {
	if rename == nil {
		rename = os.Rename
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("creating temp file: %w", err)
	}
	tmpPath := tmp.Name()
	fail := func(op string, err error) error {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("%s: %w", op, err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fail("writing temp file", err)
	}
	if err := tmp.Sync(); err != nil {
		return fail("syncing temp file", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("closing temp file: %w", err)
	}
	if err := rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("renaming into place: %w", err)
	}
	return nil
}
