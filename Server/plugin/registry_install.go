package plugin

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

const (
	maxZipBytes        = 16 * 1024 * 1024 // 16 MiB compressed
	maxUncompressedSum = 64 * 1024 * 1024 // 64 MiB total uncompressed
)

// InstallFromZip extracts an uploaded plugin zip into staging, validates it
// (zip-slip safe, no symlinks, size-capped), renames it into place and registers
// it, replacing any existing copy. It returns the plugin name.
func (r *Registry) InstallFromZip(ctx context.Context, zipBytes []byte) (string, error) {
	if r == nil || r.cfg.Directory == "" {
		return "", fmt.Errorf("plugin runtime not configured")
	}
	if int64(len(zipBytes)) > maxZipBytes {
		return "", fmt.Errorf("plugin zip exceeds %d bytes", maxZipBytes)
	}
	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		return "", fmt.Errorf("invalid zip: %w", err)
	}

	if err := os.MkdirAll(r.cfg.Directory, 0o750); err != nil {
		return "", fmt.Errorf("create plugin dir: %w", err)
	}
	stage, err := os.MkdirTemp(r.cfg.Directory, ".install-")
	if err != nil {
		return "", fmt.Errorf("create staging dir: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(stage) }

	stageAbs, absErr := filepath.Abs(stage)
	if absErr != nil {
		cleanup()
		return "", fmt.Errorf("abs staging dir: %w", absErr)
	}

	if err := installZipExtract(zr, stageAbs); err != nil {
		cleanup()
		return "", err
	}

	manifest, err := installZipStagedManifest(stageAbs)
	if err != nil {
		cleanup()
		return "", err
	}

	finalDir := filepath.Join(r.cfg.Directory, manifest.Name)
	backupDir, err := installZipPromote(stageAbs, finalDir)
	if err != nil {
		cleanup()
		return "", err
	}

	if err := r.installFromDisk(ctx, foundPlugin{
		Manifest: manifest,
		Dir:      finalDir,
		WASMPath: filepath.Join(finalDir, manifest.Entrypoint),
	}); err != nil {
		// Registration failed after the promote: drop the new tree and restore the
		// backup so a failed upgrade never destroys the working version.
		if rmErr := os.RemoveAll(finalDir); rmErr != nil {
			slog.Warn("plugin: failed to remove half-installed upgrade after installFromDisk error",
				"name", manifest.Name, "dir", finalDir, "err", rmErr)
		}
		if backupDir != "" {
			if restoreErr := os.Rename(backupDir, finalDir); restoreErr != nil {
				slog.Warn("plugin: failed to restore previous plugin version after a failed upgrade",
					"name", manifest.Name, "dir", finalDir, "backup", backupDir, "err", restoreErr)
			}
		}
		return manifest.Name, fmt.Errorf("installFromDisk: %w", err)
	}
	if backupDir != "" {
		if err := os.RemoveAll(backupDir); err != nil {
			slog.Warn("plugin: failed to remove backed-up previous version after a successful upgrade",
				"name", manifest.Name, "backup", backupDir, "err", err)
		}
	}

	r.installZipReactivate(ctx, manifest.Name)
	return manifest.Name, nil
}

// installZipExtract writes every entry into stageAbs, enforcing zip-slip, symlink and size caps per entry.
// The caller owns stageAbs and removes it on any error.
func installZipExtract(zr *zip.Reader, stageAbs string) error {
	var totalUncompressed int64
	for _, f := range zr.File {
		destAbs, entryErr := installZipEntryDest(f, stageAbs)
		if entryErr != nil {
			return entryErr
		}

		if f.Mode().IsDir() {
			if err := os.MkdirAll(destAbs, 0o750); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destAbs), 0o750); err != nil {
			return err
		}
		// Cap each file at the remaining budget so a zip bomb cannot OOM the host.
		remaining := maxUncompressedSum - totalUncompressed
		n, writeErr := installZipWriteEntry(f, destAbs, remaining)
		if writeErr != nil {
			return writeErr
		}
		totalUncompressed += n
	}
	return nil
}

// installZipEntryDest returns where an entry may be written; non-regular, symlink and escaping names are
// rejected.
func installZipEntryDest(f *zip.File, stageAbs string) (string, error) {
	if !f.Mode().IsRegular() && !f.Mode().IsDir() {
		return "", fmt.Errorf("plugin zip: refusing non-regular entry %q (mode=%v)", f.Name, f.Mode())
	}
	if f.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("plugin zip: refusing symlink %q", f.Name)
	}
	clean := filepath.Clean(f.Name)
	if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) || strings.Contains(clean, "..\\") {
		return "", fmt.Errorf("plugin zip: refusing path-traversal entry %q", f.Name)
	}
	dest := filepath.Join(stageAbs, clean)
	destAbs, dErr := filepath.Abs(dest)
	if dErr != nil {
		return "", dErr
	}
	rel, relErr := filepath.Rel(stageAbs, destAbs)
	if relErr != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", fmt.Errorf("plugin zip: refusing escape %q", f.Name)
	}
	return destAbs, nil
}

func installZipWriteEntry(f *zip.File, destAbs string, remaining int64) (int64, error) {
	rc, oErr := f.Open()
	if oErr != nil {
		return 0, oErr
	}
	out, cErr := os.OpenFile(destAbs, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if cErr != nil {
		_ = rc.Close()
		return 0, cErr
	}
	if remaining <= 0 {
		_ = rc.Close()
		_ = out.Close()
		return 0, fmt.Errorf("plugin zip: uncompressed total exceeds %d bytes", maxUncompressedSum)
	}
	n, copyErr := io.CopyN(out, rc, remaining+1)
	_ = rc.Close()
	_ = out.Close()
	if copyErr != nil && !errors.Is(copyErr, io.EOF) {
		return 0, copyErr
	}
	if n > remaining {
		return 0, fmt.Errorf("plugin zip: uncompressed total exceeds %d bytes", maxUncompressedSum)
	}
	return n, nil
}

func installZipStagedManifest(stageAbs string) (*Manifest, error) {
	manifest, err := loadManifestFromDir(stageAbs)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("plugin zip: missing plugin.json at root: %w", err)
		}
		return nil, err
	}
	if err := rejectSymlinksUnder(stageAbs); err != nil {
		return nil, err
	}
	wasmPath := filepath.Join(stageAbs, manifest.Entrypoint)
	if info, statErr := os.Lstat(wasmPath); statErr != nil {
		return nil, fmt.Errorf("entrypoint %s missing: %w", manifest.Entrypoint, statErr)
	} else if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("entrypoint %s is a symlink", manifest.Entrypoint)
	}
	return manifest, nil
}

// installZipPromote moves staging into its name directory. A previous version
// is renamed aside and returned as backupDir (empty on a fresh install or a
// hard-delete fallback). The ".install-" prefix lets LoadAll reap a backup orphaned by a crash.
func installZipPromote(stageAbs, finalDir string) (backupDir string, err error) {
	if _, statErr := os.Stat(finalDir); statErr == nil {
		tmp, mkErr := os.MkdirTemp(filepath.Dir(finalDir), ".install-old-")
		if mkErr != nil {
			return "", fmt.Errorf("stage backup dir: %w", mkErr)
		}
		// os.Rename needs the destination absent; free the name MkdirTemp reserved.
		if rmErr := os.Remove(tmp); rmErr != nil {
			return "", fmt.Errorf("free backup dir slot: %w", rmErr)
		}
		if renameErr := os.Rename(finalDir, tmp); renameErr != nil {
			// Rename failed: fall back to a destructive replace; nothing to roll back to.
			if rmAllErr := os.RemoveAll(finalDir); rmAllErr != nil {
				return "", fmt.Errorf("remove existing plugin dir: %w", rmAllErr)
			}
		} else {
			backupDir = tmp
		}
	}
	if err := os.Rename(stageAbs, finalDir); err != nil {
		if backupDir != "" {
			_ = os.Rename(backupDir, finalDir)
		}
		return "", fmt.Errorf("install rename: %w", err)
	}
	return backupDir, nil
}

// installZipReactivate re-enables a plugin that was enabled before the upgrade:
// installFromDisk registers the fresh instance disabled, and unlike LoadAll
// this caller has no activateAll afterward.
func (r *Registry) installZipReactivate(ctx context.Context, name string) {
	row, rowErr := r.cfg.Store.GetPluginByName(ctx, name)
	if rowErr != nil || row == nil || !row.Enabled {
		return
	}
	err := r.EnablePlugin(ctx, row.ID)
	if err == nil {
		return
	}
	if !errors.Is(err, ErrRuntimeUnavailable) {
		slog.Warn("plugin: reactivate after upgrade failed", "name", name, "err", err)
		return
	}
	// Default build: EnablePlugin's rollback would persistently disable a plugin
	// the admin left enabled. Preserve the intent for the next wazero start's activateAll.
	if reErr := r.cfg.Store.EnablePlugin(ctx, row.ID); reErr != nil {
		slog.Warn("plugin: could not preserve enabled flag across runtime-less upgrade",
			"name", name, "err", reErr)
		return
	}
	r.mu.Lock()
	if inst, ok := r.byName[name]; ok {
		inst.Enabled = true
	}
	r.mu.Unlock()
	slog.Info("plugin: runtime unavailable, enabled flag preserved across upgrade",
		"name", name)
}
