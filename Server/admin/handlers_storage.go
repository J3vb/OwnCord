package admin

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/diskutil"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/go-chi/chi/v5"
)

// StorageFiles is the upload directory the Storage page counts and deletes
// from; *storage.Storage satisfies it.
type StorageFiles interface {
	List() ([]storage.Entry, error)
	Delete(name string) error
}

// uploadRemovalBroadcaster tells a message's readers that one of its files was
// removed; *ws.Hub satisfies it. A hub without it (tests) still removes files,
// and readers see the change on their next load.
type uploadRemovalBroadcaster interface {
	AttachmentsChanged(ctx context.Context, res *service.AttachmentsChangedResult)
	MessageDeletedByUpload(ctx context.Context, res *service.DeleteMessageResult)
}

// storageAPI serves the Storage page: what fills the disk, every upload, bulk
// delete, leftover files, and each member's usage and own upload limit.
type storageAPI struct {
	svc     *service.Services
	files   StorageFiles
	hub     HubBroadcaster
	paths   backupPaths
	dataDir string
	// now is the clock the leftover age is measured against; tests move it.
	now func() time.Time
}

func newStorageAPI(svc *service.Services, hub HubBroadcaster, opts SetupOptions, paths backupPaths) *storageAPI {
	a := &storageAPI{svc: svc, files: opts.UploadFiles, hub: hub, paths: paths, dataDir: "data", now: time.Now}
	if opts.RunningCfg != nil && opts.RunningCfg.Server.DataDir != "" {
		a.dataDir = opts.RunningCfg.Server.DataDir
	}
	return a
}

// mountStorageRoutes registers the Storage page's routes under MANAGE_SERVER:
// seeing and freeing disk space is server management, like retention.
func mountStorageRoutes(r chi.Router, a *storageAPI) {
	r.Group(func(r chi.Router) {
		r.Use(requirePerm(permissions.ManageServer))
		r.Get("/storage/summary", a.handleSummary)
		r.Get("/storage/files", a.handleListFiles)
		r.Post("/storage/files/delete", a.handleDeleteFiles)
		r.Get("/storage/leftovers", a.handleScanLeftovers)
		r.Post("/storage/leftovers", a.handleCleanLeftovers)
		r.Get("/storage/members", a.handleMemberStorage)
		r.Patch("/users/{id}/upload-limit", a.handleSetUploadLimit)
	})
}

func (a *storageAPI) uploads(w http.ResponseWriter) (*service.UploadService, bool) {
	if a.svc == nil || a.svc.Uploads == nil {
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "upload service unavailable")
		return nil, false
	}
	return a.svc.Uploads, true
}

// storageSummary is what fills the disk. DiskFreeBytes is left out when the
// volume cannot be read.
type storageSummary struct {
	Uploads        []service.UploadKindTotal `json:"uploads"`
	UploadBytes    int64                     `json:"upload_bytes"`
	UploadCount    int64                     `json:"upload_count"`
	DatabaseBytes  int64                     `json:"database_bytes"`
	BackupBytes    int64                     `json:"backup_bytes"`
	DiskFreeBytes  *uint64                   `json:"disk_free_bytes,omitempty"`
	UserQuotaBytes int64                     `json:"user_quota_bytes"`
}

func (a *storageAPI) handleSummary(w http.ResponseWriter, r *http.Request) {
	up, ok := a.uploads(w)
	if !ok {
		return
	}
	totals, err := up.UploadTotals(r.Context())
	if err != nil {
		writeSvcErr(w, err, "", "", "failed to read upload totals")
		return
	}
	sum := storageSummary{Uploads: totals, UserQuotaBytes: up.QuotaBytes()}
	for _, t := range totals {
		sum.UploadBytes += t.Bytes
		sum.UploadCount += t.Count
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		sum.DatabaseBytes += fileSize(a.paths.dbFile + suffix)
	}
	sum.BackupBytes = dirSize(a.paths.dir)
	if free, err := diskutil.FreeBytes(a.dataDir); err == nil {
		sum.DiskFreeBytes = &free
	}
	writeJSON(w, http.StatusOK, sum)
}

// fileSize is the size of the file at p, 0 when it is missing or unreadable.
func fileSize(p string) int64 {
	info, err := os.Stat(p)
	if err != nil || !info.Mode().IsRegular() {
		return 0
	}
	return info.Size()
}

// dirSize adds up the regular files directly inside dir, 0 when it is missing.
func dirSize(dir string) int64 {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	var total int64
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		if info, err := e.Info(); err == nil {
			total += info.Size()
		}
	}
	return total
}

func (a *storageAPI) handleListFiles(w http.ResponseWriter, r *http.Request) {
	up, ok := a.uploads(w)
	if !ok {
		return
	}
	q := r.URL.Query()
	in := service.AdminUploadsRequest{Sort: q.Get("sort"), Name: q.Get("q"), Kind: q.Get("kind"), Cursor: q.Get("cursor")}
	for _, f := range []struct {
		key string
		dst *int64
	}{{"uploader", &in.UploaderID}, {"channel", &in.ChannelID}} {
		if raw := q.Get(f.key); raw != "" {
			v, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || v < 1 {
				writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, f.key+" must be a positive integer")
				return
			}
			*f.dst = v
		}
	}
	for _, f := range []struct {
		key string
		dst *int
	}{{"older_than_days", &in.OlderThanDays}, {"limit", &in.Limit}} {
		if raw := q.Get(f.key); raw != "" {
			v, err := strconv.Atoi(raw)
			if err != nil || v < 0 {
				writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, f.key+" must be a whole number")
				return
			}
			*f.dst = v
		}
	}
	page, err := up.ListAllUploads(r.Context(), in)
	if err != nil {
		writeSvcErr(w, err, "", "", "failed to list uploads")
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// storageDeleteRequest is the body of POST /storage/files/delete.
type storageDeleteRequest struct {
	IDs []string `json:"ids"`
}

// storageDeleteResult says what happened to each file of a bulk delete.
// AlreadyGone counts as done: someone else removed it first. FilesKept is how
// many rows were removed while their bytes could not be; the leftover scan
// finds those.
type storageDeleteResult struct {
	Deleted     []string `json:"deleted"`
	AlreadyGone []string `json:"already_gone"`
	InUse       []string `json:"in_use"`
	Failed      []string `json:"failed"`
	FreedBytes  int64    `json:"freed_bytes"`
	FilesKept   int      `json:"files_kept"`
}

// handleDeleteFiles removes up to service.AdminRemoveMaxFiles files. Each file
// is handled on its own and on a context the client cannot cancel, so a closed
// browser never leaves one half done: its row, bytes, announcement and audit
// entry all happen, and the answer lists what was removed and what was not.
func (a *storageAPI) handleDeleteFiles(w http.ResponseWriter, r *http.Request) {
	up, ok := a.uploads(w)
	if !ok {
		return
	}
	var req storageDeleteRequest
	if !decodeStrictJSON(w, r, &req) {
		return
	}
	ids := uniqueIDs(req.IDs)
	if len(ids) == 0 || len(ids) > service.AdminRemoveMaxFiles {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, fmt.Sprintf("ids must hold 1 to %d files", service.AdminRemoveMaxFiles))
		return
	}
	ctx := context.WithoutCancel(r.Context())
	actor := actorFromContext(r)
	res := storageDeleteResult{Deleted: []string{}, AlreadyGone: []string{}, InUse: []string{}, Failed: []string{}}
	for _, id := range ids {
		removed, err := up.RemoveUploadAsAdmin(ctx, actor, id)
		switch {
		case errors.Is(err, service.ErrUploadInUse):
			res.InUse = append(res.InUse, id)
			continue
		case errors.Is(err, service.ErrNotFound):
			res.AlreadyGone = append(res.AlreadyGone, id)
			continue
		case err != nil:
			slog.ErrorContext(ctx, "storage page: upload removal failed", "file_id", id, "error", err)
			res.Failed = append(res.Failed, id)
			continue
		}
		res.Deleted = append(res.Deleted, id)
		res.FreedBytes += removed.Size
		if !a.deleteBytes(ctx, up, removed.StoredAs) {
			res.FilesKept++
		}
		a.announce(ctx, removed)
	}
	writeJSON(w, http.StatusOK, res)
}

// uniqueIDs drops empty and repeated ids, keeping the first order.
func uniqueIDs(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, id := range in {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// deleteBytes removes a removed row's file unless another row still names it.
// It reports false when bytes that should go stayed on disk.
func (a *storageAPI) deleteBytes(ctx context.Context, up *service.UploadService, storedAs string) bool {
	if a.files == nil || storedAs == "" {
		return true
	}
	shared, err := up.StoredFileShared(ctx, storedAs)
	if err != nil {
		slog.ErrorContext(ctx, "storage page: shared file check failed", "stored_as", storedAs, "error", err)
		return false
	}
	if shared {
		return true
	}
	if err := a.files.Delete(storedAs); err != nil && !errors.Is(err, fs.ErrNotExist) {
		slog.ErrorContext(ctx, "storage page: file stayed on disk", "stored_as", storedAs, "error", err)
		return false
	}
	return true
}

// announce tells the readers of the message that held a removed file, as a
// member's own removal does. The uploader stands as the author, so a message
// left with no text and no files is deleted like theirs would be.
func (a *storageAPI) announce(ctx context.Context, removed service.AdminRemovedUpload) {
	if removed.MessageID == nil || a.svc.Messages == nil {
		return
	}
	var uploader int64
	if removed.UploaderID != nil {
		uploader = *removed.UploaderID
	}
	changed, deleted, err := a.svc.Messages.AfterAttachmentRemoved(ctx, uploader, *removed.MessageID)
	if err != nil {
		slog.ErrorContext(ctx, "storage page: removed file not announced", "message_id", *removed.MessageID, "error", err)
		return
	}
	b, ok := a.hub.(uploadRemovalBroadcaster)
	if !ok {
		return
	}
	switch {
	case deleted != nil:
		b.MessageDeletedByUpload(ctx, deleted)
	case changed != nil:
		b.AttachmentsChanged(ctx, changed)
	}
}

func (a *storageAPI) handleScanLeftovers(w http.ResponseWriter, r *http.Request) {
	up, ok := a.uploads(w)
	if !ok {
		return
	}
	scan, err := up.ScanLeftovers(r.Context(), a.lister(), a.now().Add(-service.LeftoverMinAge))
	if err != nil {
		writeSvcErr(w, err, "", "", "failed to scan for leftover files")
		return
	}
	writeJSON(w, http.StatusOK, scan)
}

// lister is the upload directory as a service.StorageLister, nil when the server
// has none (a nil interface, never a typed nil).
func (a *storageAPI) lister() service.StorageLister {
	if a.files == nil {
		return nil
	}
	return a.files
}

// handleCleanLeftovers removes up to service.LeftoverCleanupMax leftover files
// with the Storage page's 24-hour age floor, and answers what is still left.
func (a *storageAPI) handleCleanLeftovers(w http.ResponseWriter, r *http.Request) {
	up, ok := a.uploads(w)
	if !ok {
		return
	}
	if a.files == nil {
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "upload storage unavailable")
		return
	}
	ctx := context.WithoutCancel(r.Context())
	cutoff := a.now().Add(-service.LeftoverMinAge)
	removed, err := up.CleanLeftovers(ctx, a.files, cutoff, service.LeftoverCleanupMax)
	if err != nil {
		slog.ErrorContext(ctx, "storage page: leftover cleanup failed", "error", err)
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to clean up leftover files")
		return
	}
	if removed > 0 {
		up.AuditLeftoverCleanup(ctx, actorFromContext(r), removed)
	}
	left, err := up.ScanLeftovers(ctx, a.files, cutoff)
	if err != nil {
		writeSvcErr(w, err, "", "", "failed to scan for leftover files")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Removed int `json:"removed"`
		service.LeftoverScan
	}{removed, left})
}

func (a *storageAPI) handleMemberStorage(w http.ResponseWriter, r *http.Request) {
	up, ok := a.uploads(w)
	if !ok {
		return
	}
	var ids []int64
	if raw := r.URL.Query().Get("ids"); raw != "" {
		for part := range strings.SplitSeq(raw, ",") {
			v, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
			if err != nil || v < 1 {
				writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "ids must be positive integers separated by commas")
				return
			}
			ids = append(ids, v)
		}
	}
	rows, err := up.MemberStorage(r.Context(), ids)
	if err != nil {
		writeSvcErr(w, err, "", "", "failed to read member storage")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Members        []service.MemberStorage `json:"members"`
		UserQuotaBytes int64                   `json:"user_quota_bytes"`
	}{rows, up.QuotaBytes()})
}

// uploadLimitRequest is the body of PATCH /users/{id}/upload-limit. QuotaMB
// null returns the member to the server-wide limit; 0 lifts it for them.
type uploadLimitRequest struct {
	QuotaMB *int64 `json:"quota_mb"`
}

func (a *storageAPI) handleSetUploadLimit(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt64(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid user id")
		return
	}
	var req uploadLimitRequest
	if !decodeStrictJSON(w, r, &req) {
		return
	}
	up, ok := a.uploads(w)
	if !ok {
		return
	}
	if err := up.SetMemberQuota(r.Context(), actorFromContext(r), id, req.QuotaMB); err != nil {
		writeSvcErr(w, err, "user not found", "", "failed to set the upload limit")
		return
	}
	rows, err := up.MemberStorage(r.Context(), []int64{id})
	if err != nil || len(rows) == 0 {
		writeJSON(w, http.StatusOK, service.MemberStorage{UserID: id, QuotaMB: req.QuotaMB})
		return
	}
	writeJSON(w, http.StatusOK, rows[0])
}
