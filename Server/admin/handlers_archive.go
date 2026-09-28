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

// The server's global ReadTimeout/WriteTimeout are 30 s, which a
// multi-gigabyte archive cannot be built and sent in. Like the transfer
// routes (api/transfer_deadline.go), the download instead gets a progress
// deadline: every chunk written pushes the connection's deadlines out by
// archiveProgressTimeout, so a client that stops reading is abandoned, while
// a slow but moving one is not cut. archiveMaxLifetime is the hard bound on
// one archive request, build and transfer together, however it progresses:
// 2 h carries tens of gigabytes over an ordinary uplink.
const (
	archiveProgressTimeout = 30 * time.Second
	archiveMaxLifetime     = 2 * time.Hour
)

// archiveName is the download's fixed name. The snapshot inside is a real
// database copy; the fixed name means a browser never overwrites two archives
// with each other's confusing name.
const archiveName = "owncord-archive.zip"

// archiveWorkPrefix names each build's work dir under the backup dir, so the
// backup maintenance sweep can reclaim one a killed process left behind.
const archiveWorkPrefix = "owncord-archive-"

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
		if opts.RunningCfg == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "server configuration unavailable")
			return
		}
		// Nothing is written while the archive builds, so the build runs
		// under the lifetime bound alone; the copy below re-arms per chunk.
		progress := archiveProgressWriter{
			w:     w,
			ctl:   http.NewResponseController(w),
			idle:  archiveProgressTimeout,
			until: time.Now().Add(archiveMaxLifetime),
		}
		progress.setDeadlines(progress.until)

		// The work dir lives under backup.dir: the snapshot is a VACUUM INTO
		// target, and that directory is already the one backups write to.
		if err := os.MkdirAll(backupBaseDir, 0o750); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not prepare the archive")
			return
		}
		work, err := os.MkdirTemp(backupBaseDir, archiveWorkPrefix)
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

		actor := actorFromContext(r)
		slog.Warn("backup archive downloaded", "actor_id", actor, "bytes", info.Size())
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "backup_archive", "server", 0,
			fmt.Sprintf("downloaded full archive (%d bytes)", info.Size()))

		if _, err := io.Copy(progress, f); err != nil {
			// Headers are already committed; the client sees a truncated
			// download. Log it — the operator can retry.
			slog.Warn("backup archive download interrupted", "err", err)
		}
	})
}

// archiveProgressWriter re-arms the connection's read and write deadlines to
// now+idle on every write that lands bytes, never past until.
type archiveProgressWriter struct {
	w     io.Writer
	ctl   *http.ResponseController
	idle  time.Duration
	until time.Time
}

func (p archiveProgressWriter) Write(b []byte) (int, error) {
	n, err := p.w.Write(b)
	if n > 0 {
		deadline := time.Now().Add(p.idle)
		if deadline.After(p.until) {
			deadline = p.until
		}
		p.setDeadlines(deadline)
	}
	return n, err
}

// setDeadlines sets both deadlines; the read one too, because on HTTP/1.1 an
// expired read deadline cancels the request context mid-response. Errors are
// ignored: the only realistic one is http.ErrNotSupported on a writer with no
// connection, where there is no deadline to manage.
func (p archiveProgressWriter) setDeadlines(deadline time.Time) {
	_ = p.ctl.SetReadDeadline(deadline)
	_ = p.ctl.SetWriteDeadline(deadline)
}

// buildArchive writes the archive to work/owncord-archive.zip and returns its
// path. It snapshots the live database with VACUUM INTO and walks the data
// directory wholesale (docs/deployment.md's rule: copy data/, never a hand
// list), replacing the live database file with the snapshot and leaving out
// the backup directory.
func buildArchive(ctx context.Context, database *db.DB, opts SetupOptions, work string) (string, error) {
	cfg := opts.RunningCfg
	snapshot := filepath.Join(work, "snapshot.db")
	if err := database.BackupToSafe(ctx, snapshot, work); err != nil {
		return "", fmt.Errorf("snapshotting database: %w", err)
	}
	if err := os.Chmod(snapshot, 0o600); err != nil {
		return "", fmt.Errorf("restricting snapshot: %w", err)
	}

	outPath := filepath.Join(work, archiveName)
	out, err := os.Create(outPath) //nolint:gosec // G304: our own temp path
	if err != nil {
		return "", fmt.Errorf("creating archive: %w", err)
	}
	defer out.Close() //nolint:errcheck
	zw := zip.NewWriter(out)

	if err := addTrees(zw, cfg.Server.DataDir, cfg.Upload.StorageDir, backupBaseDir, work, snapshot); err != nil {
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

// resolvePath returns p as an absolute path with symlinks resolved, or just
// absolute when it does not exist yet.
func resolvePath(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real, nil
	}
	return abs, nil
}

// isWithin reports whether path is root or lies below it.
func isWithin(path, root string) bool {
	return path == root || strings.HasPrefix(path, root+string(filepath.Separator))
}

// addTrees adds the data directory as "data/..." and, when upload.storage_dir
// lives outside it, the uploads as "data/uploads/...". The live database file
// is replaced by the snapshot, and the backup and work directories, the
// database's WAL sidecars and any in-progress *.tmp file are left out.
func addTrees(zw *zip.Writer, dataDir, uploadsDir, backupDir, work, snapshot string) error {
	absData, err := filepath.Abs(dataDir)
	if err != nil {
		return fmt.Errorf("resolving data dir: %w", err)
	}
	realData, err := filepath.EvalSymlinks(absData)
	if err != nil {
		return fmt.Errorf("resolving data dir: %w", err)
	}
	t := archiveTree{zw: zw, snapshot: snapshot}
	if t.db, err = resolvePath(dbFilePath); err != nil {
		return fmt.Errorf("resolving database path: %w", err)
	}
	if t.uploads, err = resolvePath(uploadsDir); err != nil {
		return fmt.Errorf("resolving uploads dir: %w", err)
	}
	for _, dir := range []string{backupDir, work} {
		abs, err := resolvePath(dir)
		if err != nil {
			return fmt.Errorf("resolving %s: %w", dir, err)
		}
		t.skip = append(t.skip, abs)
	}

	if err := t.walk(realData, "data"); err != nil {
		return fmt.Errorf("archiving data dir: %w", err)
	}
	if !isWithin(t.uploads, realData) {
		if _, err := os.Stat(t.uploads); err == nil {
			if err := t.walk(t.uploads, "data/uploads"); err != nil {
				return fmt.Errorf("archiving uploads dir: %w", err)
			}
		}
	}
	// A configured database outside the data dir is still part of "everything
	// a restore needs" — put it at the conventional path so the restore steps
	// in the docs still find it.
	if !t.snapshotAdded {
		info, err := os.Stat(snapshot)
		if err != nil {
			return err
		}
		if err := addFile(zw, "data/chatserver.db", snapshot, info, zip.Deflate); err != nil {
			return err
		}
	}
	return nil
}

// archiveTree walks directories into one zip, sharing the exclusions and
// the live-database substitution across every walked root. Files under
// uploads are stored as-is: attachments are mostly already-compressed media,
// and recompressing them only slows the build.
type archiveTree struct {
	zw            *zip.Writer
	db            string
	uploads       string
	snapshot      string
	skip          []string
	snapshotAdded bool
}

// walk adds every regular file under root to the zip as "prefix/<relative>".
// root itself is never skipped, even when it is a skipped directory.
func (t *archiveTree) walk(root, prefix string) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(filepath.Join(prefix, rel))
		info, err := d.Info()
		if err != nil {
			return err
		}

		if d.IsDir() {
			if rel == "." {
				return nil
			}
			for _, skip := range t.skip {
				if path == skip {
					return filepath.SkipDir
				}
			}
			return addDir(t.zw, name, info)
		}
		if !d.Type().IsRegular() {
			return nil // symlinks, sockets and devices are not backed up
		}
		// The live database is replaced by the snapshot; its WAL sidecars are
		// superseded by it. The WAL belongs to dbFilePath, not this walk.
		if path == t.db {
			if err := addFile(t.zw, name, t.snapshot, info, zip.Deflate); err != nil {
				return err
			}
			t.snapshotAdded = true
			return nil
		}
		if strings.HasPrefix(path, t.db+"-") || strings.HasSuffix(path, ".tmp") {
			return nil // -wal / -shm, and in-progress writes
		}
		method := zip.Deflate
		if isWithin(path, t.uploads) {
			method = zip.Store
		}
		return addFile(t.zw, name, path, info, method)
	})
}

// addDir adds a directory entry carrying info's mode and mtime.
func addDir(zw *zip.Writer, name string, info os.FileInfo) error {
	hdr, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	hdr.Name = name + "/"
	_, err = zw.CreateHeader(hdr)
	return err
}

// addFile copies src into the zip under name with method, carrying info's
// mode and mtime so an extracted key file keeps its 0600.
func addFile(zw *zip.Writer, name, src string, info os.FileInfo, method uint16) error {
	in, err := os.Open(src) //nolint:gosec // G304: path from our own walk
	if err != nil {
		return err
	}
	defer in.Close() //nolint:errcheck
	hdr, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	hdr.Name = name
	hdr.Method = method
	w, err := zw.CreateHeader(hdr)
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
	info, err := os.Stat(configPath)
	if err != nil {
		return nil
	}
	return addFile(zw, "config.yaml", configPath, info, zip.Deflate)
}
