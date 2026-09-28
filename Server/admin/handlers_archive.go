package admin

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/diskutil"
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
		deadline, ctx := startArchive(w, r, archiveProgressTimeout, archiveMaxLifetime)
		defer deadline.release()

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

		zipPath, err := buildArchive(ctx, database, opts, work)
		if errors.Is(err, errArchiveNoSpace) {
			writeErr(w, http.StatusInsufficientStorage, "STORAGE_LOW_DISK", err.Error())
			return
		}
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

		if _, err := io.Copy(deadline, f); err != nil {
			// Headers are already committed; the client sees a truncated
			// download. Log it — the operator can retry.
			slog.Warn("backup archive download interrupted", "err", err)
		}
	})
}

// archiveBeforeSnapshotHook, when set, runs between the space check and the
// snapshot; tests use it to land an upload in that window.
var archiveBeforeSnapshotHook func()

// buildArchive writes the archive to work/owncord-archive.zip and returns its
// path. It snapshots the live database with VACUUM INTO and walks the data
// directory wholesale (docs/deployment.md's rule: copy data/, never a hand
// list), replacing the live database file with the snapshot and leaving out
// the backup directory. Before the snapshot it refuses with errArchiveNoSpace
// when the build would take the backup volume below server.min_free_disk_mb;
// that estimate's plan is then retaken, so the zip is written from a walk
// that follows the snapshot.
func buildArchive(ctx context.Context, database *db.DB, opts SetupOptions, work string) (string, error) {
	cfg := opts.RunningCfg
	snapshot := filepath.Join(work, "snapshot.db")
	plan := func() (*archiveTree, error) {
		return planTrees(ctx, cfg.Server.DataDir, cfg.Upload.StorageDir, backupBaseDir, work, snapshot)
	}
	t, err := plan()
	if err != nil {
		return "", err
	}
	if err := checkArchiveSpace(work, t.need(), cfg.Server.MinFreeDiskBytes()); err != nil {
		return "", err
	}
	if archiveBeforeSnapshotHook != nil {
		archiveBeforeSnapshotHook()
	}
	if err := database.BackupToSafe(ctx, snapshot, work); err != nil {
		return "", fmt.Errorf("snapshotting database: %w", err)
	}
	if err := os.Chmod(snapshot, 0o600); err != nil {
		return "", fmt.Errorf("restricting snapshot: %w", err)
	}
	// Write from a plan taken after the snapshot: an upload lands its file
	// before its row, so every file a snapshotted row names is on disk by
	// now, while the first plan may predate it.
	if t, err = plan(); err != nil {
		return "", err
	}

	outPath := filepath.Join(work, archiveName)
	out, err := os.Create(outPath) //nolint:gosec // G304: our own temp path
	if err != nil {
		return "", fmt.Errorf("creating archive: %w", err)
	}
	defer out.Close() //nolint:errcheck
	zw := zip.NewWriter(out)

	if err := t.write(zw); err != nil {
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

// errArchiveNoSpace refuses a build that would take its volume below
// server.min_free_disk_mb.
var errArchiveNoSpace = errors.New("not enough free disk space in the backup directory to build the archive")

// checkArchiveSpace refuses when writing need bytes under dir would leave
// less than floor free. A volume whose free space cannot be read is not
// treated as full.
func checkArchiveSpace(dir string, need, floor uint64) error {
	free, err := diskutil.FreeBytes(dir)
	if err != nil {
		return nil
	}
	if free < need || free-need < floor {
		return fmt.Errorf("%w: it needs about %d MB, %d MB is free, and %d MB is kept in reserve (server.min_free_disk_mb)",
			errArchiveNoSpace, need>>20, free>>20, floor>>20)
	}
	return nil
}

// planTrees plans the data directory as "data/..." and, when
// upload.storage_dir lives outside it, the uploads as "data/uploads/...". The
// live database file is replaced by the snapshot, and the backup and work
// directories, the database's WAL sidecars and any in-progress *.tmp file are
// left out.
func planTrees(ctx context.Context, dataDir, uploadsDir, backupDir, work, snapshot string) (*archiveTree, error) {
	absData, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, fmt.Errorf("resolving data dir: %w", err)
	}
	realData, err := filepath.EvalSymlinks(absData)
	if err != nil {
		return nil, fmt.Errorf("resolving data dir: %w", err)
	}
	t := &archiveTree{ctx: ctx, snapshot: snapshot}
	if t.db, err = resolvePath(dbFilePath); err != nil {
		return nil, fmt.Errorf("resolving database path: %w", err)
	}
	if t.uploads, err = resolvePath(uploadsDir); err != nil {
		return nil, fmt.Errorf("resolving uploads dir: %w", err)
	}
	for _, dir := range []string{backupDir, work} {
		abs, err := resolvePath(dir)
		if err != nil {
			return nil, fmt.Errorf("resolving %s: %w", dir, err)
		}
		t.skip = append(t.skip, abs)
	}

	if err := t.walk(realData, "data"); err != nil {
		return nil, fmt.Errorf("archiving data dir: %w", err)
	}
	if !isWithin(t.uploads, realData) {
		if _, err := os.Stat(t.uploads); err == nil {
			if err := t.walk(t.uploads, "data/uploads"); err != nil {
				return nil, fmt.Errorf("archiving uploads dir: %w", err)
			}
		}
	}
	return t, nil
}

// archiveEntry is one planned zip member; a directory when src is empty.
type archiveEntry struct {
	name   string
	src    string
	info   os.FileInfo
	method uint16
}

// archiveTree plans directories into one zip, sharing the exclusions and
// the live-database substitution across every walked root, then writes them.
// Files under uploads are stored as-is: attachments are mostly
// already-compressed media, and recompressing them only slows the build.
type archiveTree struct {
	ctx           context.Context
	db            string
	uploads       string
	snapshot      string
	skip          []string
	entries       []archiveEntry
	fileBytes     uint64 // planned file bytes, the database aside
	snapshotAdded bool
}

// need is roughly the disk space the build takes: every planned file once in
// the zip, and the database twice (the snapshot, then its copy in the zip).
func (t *archiveTree) need() uint64 {
	var dbBytes uint64
	if info, err := os.Stat(t.db); err == nil {
		dbBytes = uint64(info.Size()) //nolint:gosec // G115: a file size is never negative
	}
	return t.fileBytes + 2*dbBytes
}

// write adds the planned entries to zw. A file removed since it was planned
// is left out; the snapshot must exist. A configured database outside the
// data dir is still part of "everything a restore needs", so it goes at the
// conventional path the restore steps in the docs expect.
func (t *archiveTree) write(zw *zip.Writer) error {
	for _, e := range t.entries {
		if err := t.ctx.Err(); err != nil {
			return err
		}
		if e.src == "" {
			if err := addDir(zw, e.name, e.info); err != nil {
				return err
			}
			continue
		}
		err := addFile(zw, e.name, e.src, e.info, e.method)
		if err != nil && (e.src == t.snapshot || !errors.Is(err, fs.ErrNotExist)) {
			return err
		}
	}
	if t.snapshotAdded {
		return nil
	}
	info, err := os.Stat(t.snapshot)
	if err != nil {
		return err
	}
	return addFile(zw, "data/chatserver.db", t.snapshot, info, zip.Deflate)
}

// walk plans every regular file under root as "prefix/<relative>".
func (t *archiveTree) walk(root, prefix string) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		return t.visit(root, prefix, path, d, walkErr)
	})
}

// visit plans one entry of walk. root itself is never skipped, even when it
// is a skipped directory, and must exist; any other entry removed while the
// walk runs (the live server deletes uploads and renames temp files away) is
// left out rather than failing the archive.
func (t *archiveTree) visit(root, prefix, path string, d os.DirEntry, walkErr error) error {
	if err := t.ctx.Err(); err != nil {
		return err
	}
	vanished := func(err error) bool { return path != root && errors.Is(err, fs.ErrNotExist) }
	if walkErr != nil {
		if vanished(walkErr) {
			return nil
		}
		return walkErr
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return err
	}
	name := filepath.ToSlash(filepath.Join(prefix, rel))
	// The live database's WAL sidecars are superseded by the snapshot (the
	// WAL belongs to dbFilePath, not this walk); *.tmp files are in-progress
	// writes.
	if !d.IsDir() && (strings.HasPrefix(path, t.db+"-") || strings.HasSuffix(path, ".tmp")) {
		return nil
	}
	info, err := d.Info()
	if err != nil {
		if vanished(err) {
			return nil
		}
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
		t.entries = append(t.entries, archiveEntry{name: name, info: info})
		return nil
	}
	if !d.Type().IsRegular() {
		return nil // symlinks, sockets and devices are not backed up
	}
	// The live database is replaced by the snapshot.
	if path == t.db {
		t.entries = append(t.entries, archiveEntry{name: name, src: t.snapshot, info: info, method: zip.Deflate})
		t.snapshotAdded = true
		return nil
	}
	method := zip.Deflate
	if isWithin(path, t.uploads) {
		method = zip.Store
	}
	t.entries = append(t.entries, archiveEntry{name: name, src: path, info: info, method: method})
	t.fileBytes += uint64(info.Size()) //nolint:gosec // G115: a file size is never negative
	return nil
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
