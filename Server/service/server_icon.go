package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image/png"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// The owner-uploaded server icon is one PNG file in the data directory, and that file is the only source of
// truth for it: its content hash (what server-info reports and the GET ETag carries) is computed from the bytes
// on disk, so what clients compare is always what GET serves, whatever the database says. The file is written
// through a synced temp file and a rename, so a crash or a failed rename leaves the previous icon whole. The
// server_icon settings row mirrors the hash for the admin Settings page and older tooling; it is written after
// the rename on a best-effort basis and nothing reads it for decisions, so a failed or stale row (or a database
// restored next to a different file) cannot make clients and the picture disagree.
const (
	// ServerIconKey is the settings row mirroring the icon's content hash ("" when none).
	ServerIconKey = "server_icon"
	// ServerIconFile is the icon's file name inside the data directory.
	ServerIconFile = "server-icon.png"
	// ServerIconMaxBytes bounds an upload and the stored (re-encoded) file; 256x256 art fits many times over.
	ServerIconMaxBytes = 64 << 10
	// ServerIconMinPx and ServerIconMaxPx bound the (square) side length.
	ServerIconMinPx   = 32
	ServerIconMaxPx   = 256
	serverIconHashLen = 16
)

// ErrNoServerIcon reports that the server has no icon.
var ErrNoServerIcon = errors.New("no server icon")

// ErrServerIconUnavailable reports a server built without a data directory for the icon (a test double).
var ErrServerIconUnavailable = errors.New("server icon storage unavailable")

// iconSnapshot is the hash of the file as last read, valid while the file's size and mtime are unchanged.
type iconSnapshot struct {
	size  int64
	mtime time.Time
	hash  string
}

// SetServerIconDir installs the directory the icon file lives in and sweeps a temp file a crash left behind;
// the composition root calls it once, before the server takes requests.
func (s *SettingsService) SetServerIconDir(dir string) {
	s.iconDir = dir
	if dir == "" {
		return
	}
	stale, err := filepath.Glob(filepath.Join(dir, ServerIconFile+".tmp-*"))
	if err != nil {
		return
	}
	for _, path := range stale {
		_ = os.Remove(path)
	}
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

// ValidateServerIcon checks an upload (a PNG that decodes, square, 32 to 256 px a side, at most 64 KiB) and
// returns the bytes to store: the decoded image encoded afresh, which drops text, EXIF-like and any other
// ancillary chunks and trailing data. Failures wrap ErrBadRequest.
func ValidateServerIcon(data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, fmt.Errorf("server icon is empty%.0w", ErrBadRequest)
	}
	if len(data) > ServerIconMaxBytes {
		return nil, fmt.Errorf("server icon must be at most %d KiB%.0w", ServerIconMaxBytes>>10, ErrBadRequest)
	}
	// The header first: a tiny file can declare a huge canvas, and the full decode must never see one.
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("server icon must be a PNG image%.0w", ErrBadRequest)
	}
	if cfg.Width != cfg.Height {
		return nil, fmt.Errorf("server icon must be square%.0w", ErrBadRequest)
	}
	if cfg.Width < ServerIconMinPx || cfg.Width > ServerIconMaxPx {
		return nil, fmt.Errorf("server icon must be between %d and %d pixels wide%.0w", ServerIconMinPx, ServerIconMaxPx, ErrBadRequest)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("server icon must be a PNG image%.0w", ErrBadRequest)
	}
	var out bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&out, img); err != nil {
		return nil, fmt.Errorf("server icon must be a PNG image%.0w", ErrBadRequest)
	}
	if out.Len() > ServerIconMaxBytes {
		return nil, fmt.Errorf("server icon is too detailed: it must stay under %d KiB%.0w", ServerIconMaxBytes>>10, ErrBadRequest)
	}
	return out.Bytes(), nil
}

// SetServerIcon validates and stores a new icon and returns its hash. The file is written to a temp file in
// the data directory, synced and renamed into place; a failure at any step leaves the previous icon.
func (s *SettingsService) SetServerIcon(ctx context.Context, actorID int64, data []byte) (string, error) {
	clean, err := ValidateServerIcon(data)
	if err != nil {
		return "", err
	}
	path, err := s.iconPath()
	if err != nil {
		return "", err
	}
	s.iconMu.Lock()
	defer s.iconMu.Unlock()
	if err := writeFileAtomic(path, clean, s.iconRename); err != nil {
		return "", fmt.Errorf("SetServerIcon: %w", err)
	}
	hash := ServerIconHashOf(clean)
	s.iconSnap = nil
	s.mirrorServerIconRow(ctx, hash)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "setting_change", "setting", 0, ServerIconKey+" updated")
	return hash, nil
}

// ClearServerIcon removes the icon file; removing none is not an error.
func (s *SettingsService) ClearServerIcon(ctx context.Context, actorID int64) error {
	path, err := s.iconPath()
	if err != nil {
		return err
	}
	s.iconMu.Lock()
	defer s.iconMu.Unlock()
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("ClearServerIcon: %w", err)
	}
	s.iconSnap = nil
	s.mirrorServerIconRow(ctx, "")
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "setting_change", "setting", 0, ServerIconKey+" removed")
	return nil
}

// mirrorServerIconRow writes the hash to the server_icon row. It cannot fail the change: the file already
// decided the icon, and the row is only a mirror.
func (s *SettingsService) mirrorServerIconRow(ctx context.Context, hash string) {
	if err := s.st.ApplySettings(context.WithoutCancel(ctx), map[string]string{ServerIconKey: hash}); err != nil {
		slog.WarnContext(ctx, "server icon update failed", "stage", "row", "error", err)
	}
}

// ServerIconHash is the hash of the icon file on disk, "" when there is none. It re-reads the file only when
// its size or modification time changed.
func (s *SettingsService) ServerIconHash(_ context.Context) (string, error) {
	_, hash, err := s.readServerIcon(false)
	if errors.Is(err, ErrNoServerIcon) || errors.Is(err, ErrServerIconUnavailable) {
		return "", nil
	}
	return hash, err
}

// ServerIcon returns the icon bytes and their hash, or ErrNoServerIcon.
func (s *SettingsService) ServerIcon(_ context.Context) ([]byte, string, error) {
	return s.readServerIcon(true)
}

func (s *SettingsService) readServerIcon(wantBytes bool) ([]byte, string, error) {
	path, err := s.iconPath()
	if err != nil {
		return nil, "", err
	}
	s.iconMu.Lock()
	defer s.iconMu.Unlock()
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			s.iconSnap = nil
			return nil, "", ErrNoServerIcon
		}
		return nil, "", fmt.Errorf("server icon: %w", err)
	}
	if snap := s.iconSnap; snap != nil && !wantBytes && snap.size == info.Size() && snap.mtime.Equal(info.ModTime()) {
		return nil, snap.hash, nil
	}
	data, err := os.ReadFile(path) //nolint:gosec // G304: the path is <data_dir>/server-icon.png, not input
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, "", ErrNoServerIcon
		}
		return nil, "", fmt.Errorf("server icon: %w", err)
	}
	hash := ServerIconHashOf(data)
	s.iconSnap = &iconSnapshot{size: int64(len(data)), mtime: info.ModTime(), hash: hash}
	return data, hash, nil
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
