package admin

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// archiveWriteWindow bounds one archive download's write deadline. The
// server's global WriteTimeout is 30 s, which a multi-gigabyte archive cannot
// finish in; this is set once on the underlying connection before the copy,
// mirroring the bounded window the transfer routes use, so a stalled client is
// still abandoned rather than holding the handler forever.
const archiveWriteWindow = 10 * time.Minute

// archiveName is the download's fixed name. The snapshot inside is a real
// database copy; the fixed name means a browser never overwrites two archives
// with each other's confusing name.
const archiveName = "owncord-archive.zip"

// handleArchive serves GET /admin/api/archive: one zip carrying everything a
// restore needs that a database backup does not — the whole data directory
// (uploads, the key files, erasure markers, TLS material) and config.yaml
// (O3). The live SQLite file is replaced by a `VACUUM INTO` snapshot, so the
// archive is a consistent copy even while the server runs.
//
// It is Owner-only: the archive holds password hashes and the key files.
func handleArchive(database *db.DB, opts SetupOptions) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Build the whole zip in a temp directory, then stream it. A failure
		// mid-build must be a clean 500 rather than a half-written zip the
		// browser saves as corrupt; only after the build succeeds do we write
		// a status.
		work, err := os.MkdirTemp("", "owncord-archive-")
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not prepare the archive")
			return
		}
		defer func() { _ = os.RemoveAll(work) }()

		zipPath, err := buildArchive(r.Context(), database, opts, work)
		if err != nil {
			slog.Error("backup archive build failed", "err", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not build the archive")
			return
		}

		f, err := os.Open(zipPath) //nolint:gosec // G304: path is our own temp file
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not build the archive")
			return
		}
		defer f.Close() //nolint:errcheck
		info, err := f.Stat()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not build the archive")
			return
		}

		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", `attachment; filename="`+archiveName+`"`)
		w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// The archive can outlive the global write deadline; give this
		// connection its own bounded window (a stalled client still times out).
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(archiveWriteWindow))

		actor := actorFromContext(r)
		slog.Warn("backup archive downloaded", "actor_id", actor, "bytes", info.Size())
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "backup_archive", "server", 0,
			fmt.Sprintf("downloaded full archive (%d bytes)", info.Size()))

		if _, err := io.Copy(w, f); err != nil {
			// Headers are already committed; the client sees a truncated
			// download. Log it — the operator can retry.
			slog.Warn("backup archive download interrupted", "err", err)
		}
	})
}

// buildArchive writes the archive to work/owncord-archive.zip and returns its
// path. It snapshots the live database with VACUUM INTO and walks the data
// directory wholesale (docs/deployment.md's rule: copy data/, never a hand
// list), replacing the live database file with the snapshot.
func buildArchive(ctx context.Context, database *db.DB, opts SetupOptions, work string) (string, error) {
	dataDir := dataDirFor(opts, database)
	snapshot := filepath.Join(work, "snapshot.db")
	if err := database.BackupToSafe(ctx, snapshot, work); err != nil {
		return "", fmt.Errorf("snapshotting database: %w", err)
	}

	outPath := filepath.Join(work, archiveName)
	out, err := os.Create(outPath) //nolint:gosec // G304: our own temp path
	if err != nil {
		return "", fmt.Errorf("creating archive: %w", err)
	}
	defer out.Close() //nolint:errcheck
	zw := zip.NewWriter(out)

	if err := walkDataDir(zw, dataDir, snapshot, database); err != nil {
		_ = zw.Close()
		return "", err
	}
	if err := addConfig(zw, opts.ConfigPath); err != nil {
		_ = zw.Close()
		return "", err
	}
	if err := zw.Close(); err != nil {
		return "", fmt.Errorf("finalizing archive: %w", err)
	}
	if err := out.Close(); err != nil {
		return "", fmt.Errorf("closing archive: %w", err)
	}
	return outPath, nil
}

// dataDirFor resolves the directory to archive: the configured data dir, or
// the live database file's directory when the config is unavailable (the
// legacy construction path, or an in-memory test).
func dataDirFor(opts SetupOptions, database *db.DB) string {
	if opts.RunningCfg != nil && opts.RunningCfg.Server.DataDir != "" {
		return opts.RunningCfg.Server.DataDir
	}
	if database != nil {
		if dir := filepath.Dir(dbFilePath); dir != "" && dir != "." {
			return dir
		}
	}
	return filepath.Join("data")
}

// walkDataDir adds every regular file under dataDir to the archive as
// "data/<relative>", replacing the live database file with the snapshot and
// skipping the database's WAL sidecars (the snapshot supersedes them).
func walkDataDir(zw *zip.Writer, dataDir, snapshot string, database *db.DB) error {
	absData, err := filepath.Abs(dataDir)
	if err != nil {
		return fmt.Errorf("resolving data dir: %w", err)
	}
	absDB, _ := filepath.Abs(dbFilePath)

	snapshotAdded := false
	err = filepath.WalkDir(absData, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(absData, path)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(filepath.Join("data", rel))

		if d.IsDir() {
			if rel == "." {
				return nil
			}
			_, err := zw.Create(name + "/")
			return err
		}
		if !d.Type().IsRegular() {
			return nil // symlinks, sockets and devices are not backed up
		}
		abs := path
		// The live database is replaced by the snapshot; its WAL sidecars are
		// superseded by it. The WAL belongs to dbFilePath, not this walk.
		if abs == absDB {
			if err := addFile(zw, name, snapshot); err != nil {
				return err
			}
			snapshotAdded = true
			return nil
		}
		if strings.HasPrefix(abs, absDB+"-") {
			return nil // -wal / -shm
		}
		return addFile(zw, name, abs)
	})
	if err != nil {
		return fmt.Errorf("archiving data dir: %w", err)
	}
	// A configured database outside the data dir is still part of "everything
	// a restore needs" — put it at the conventional path so the restore steps
	// in the docs still find it.
	if !snapshotAdded && absDB != "" {
		if err := addFile(zw, "data/chatserver.db", snapshot); err != nil {
			return err
		}
	}
	return nil
}

// addFile copies src into the zip under name.
func addFile(zw *zip.Writer, name, src string) error {
	in, err := os.Open(src) //nolint:gosec // G304: path from our own walk
	if err != nil {
		return err
	}
	defer in.Close() //nolint:errcheck
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	if _, err := io.Copy(w, in); err != nil {
		return fmt.Errorf("archiving %s: %w", name, err)
	}
	return nil
}

// addConfig adds config.yaml when it exists. Its absence is not a failure —
// the archive is the recovery path and the data dir is still worth having.
func addConfig(zw *zip.Writer, configPath string) error {
	if configPath == "" {
		return nil
	}
	if _, err := os.Stat(configPath); err != nil {
		return nil
	}
	return addFile(zw, "config.yaml", configPath)
}
