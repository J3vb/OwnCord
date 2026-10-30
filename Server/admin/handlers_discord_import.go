package admin

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/service/discordimport"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// DefaultImportMaxBytes is the export upload cap when SetupOptions names none;
// it matches upload.import_max_mb's default.
const DefaultImportMaxBytes = 500 << 20

// ImportDirName is the folder under the data directory that holds uploaded
// exports while they import. The archive leaves it out.
const ImportDirName = "import-tmp"

const (
	// importMinUploadRate is the slowest uplink an upload is sized for, in
	// bytes per second (2 Mbit/s).
	importMinUploadRate = 250 << 10
	// importMinLifetime is the shortest total time an upload gets, the same
	// 10 minutes the file routes allow.
	importMinLifetime = 10 * time.Minute
)

// importTransferLifetime is how long an upload of up to maxBytes may take: long
// enough for the cap at importMinUploadRate, and never under importMinLifetime.
// The stall deadline still ends a peer that stops sending.
func importTransferLifetime(maxBytes int64) time.Duration {
	secs := min(maxBytes/importMinUploadRate, 1<<30)
	return max(importMinLifetime, time.Duration(secs)*time.Second)
}

// maxAuditSourceRunes bounds the file name an audit row carries.
const maxAuditSourceRunes = 100

// DiscordImporter is the import runner the admin routes drive;
// *discordimport.Runner satisfies it.
type DiscordImporter interface {
	Start(ctx context.Context, req discordimport.Request) (*discordimport.Job, error)
	Running(id int64) *discordimport.Job
	Status(ctx context.Context, id int64) (*db.ImportJob, error)
	Latest(ctx context.Context) (*db.ImportJob, error)
	CategoryExists(ctx context.Context, id int64) (bool, error)
}

// TransferBegin starts the long-transfer deadline for one request and returns
// the body wrapped to renew it as bytes arrive, plus the release to defer.
// lifetime is how long the whole transfer may take however steadily it
// progresses (see importTransferLifetime). Nil
// in SetupOptions leaves a plain size-capped body.
type TransferBegin func(w http.ResponseWriter, r *http.Request, maxBytes int64, lifetime time.Duration) (body io.ReadCloser, release func())

// discordImportAPI holds what the Discord import routes share.
type discordImportAPI struct {
	importer  DiscordImporter
	audit     db.Auditor
	retention *service.RetentionService
	group     *syncutil.Group
	begin     TransferBegin
	dir       string
	maxBytes  int64
	// minFree is the free space kept in reserve on the import volume.
	minFree uint64
	// cancelledBy remembers who asked to cancel a job, for the audit row
	// written once the job really ended cancelled.
	cancelMu    syncutil.Mutex
	cancelledBy map[int64]int64
	// uploading is set while an upload is being received or started, so two
	// large uploads never spool at once.
	uploading atomic.Bool
}

func newDiscordImportAPI(audit db.Auditor, retention *service.RetentionService, opts SetupOptions) *discordImportAPI {
	var minFree uint64
	if opts.RunningCfg != nil {
		minFree = opts.RunningCfg.Server.MinFreeDiskBytes()
	}
	return &discordImportAPI{
		minFree:     minFree,
		cancelledBy: map[int64]int64{},
		importer:    opts.DiscordImport,
		audit:       audit,
		retention:   retention,
		group:       opts.Background,
		begin:       opts.BeginTransfer,
		dir:         cmp.Or(opts.ImportDir, os.TempDir()),
		maxBytes:    cmp.Or(opts.ImportMaxBytes, DefaultImportMaxBytes),
	}
}

// importJobResponse is a job as the panel reads it.
type importJobResponse struct {
	ID                 int64   `json:"id"`
	Status             string  `json:"status"`
	SourceName         string  `json:"source_name"`
	Imported           int64   `json:"imported"`
	Skipped            int64   `json:"skipped"`
	SkippedAttachments int64   `json:"skipped_attachments"`
	Total              int64   `json:"total"`
	Error              *string `json:"error"`
	CreatedAt          string  `json:"created_at"`
	FinishedAt         *string `json:"finished_at"`
}

func importJobDTO(j *db.ImportJob) importJobResponse {
	return importJobResponse{
		ID: j.ID, Status: j.Status, SourceName: j.SourceName, Imported: j.Imported, Skipped: j.Skipped,
		SkippedAttachments: j.SkippedAttachments, Total: j.Total, Error: j.Error,
		CreatedAt: j.CreatedAt, FinishedAt: j.FinishedAt,
	}
}

// latestImportResponse is GET /discord-imports/latest: the newest job (null
// when none ran) and the facts the panel's form shows.
type latestImportResponse struct {
	Job *importJobResponse `json:"job"`
	// RetentionDays is the server-wide message window, 0 when messages are kept.
	RetentionDays int `json:"retention_days"`
	// MaxUploadBytes is the largest export file the upload takes.
	MaxUploadBytes int64 `json:"max_upload_bytes"`
}

func (a *discordImportAPI) unavailable(w http.ResponseWriter) bool {
	if a.importer == nil {
		writeErr(w, http.StatusServiceUnavailable, httperr.CodeServiceUnavailable, "Discord import is unavailable on this server")
		return true
	}
	return false
}

// handleLatest answers GET /discord-imports/latest.
func (a *discordImportAPI) handleLatest(w http.ResponseWriter, r *http.Request) {
	if a.unavailable(w) {
		return
	}
	out := latestImportResponse{MaxUploadBytes: a.maxBytes}
	job, err := a.importer.Latest(r.Context())
	switch {
	case err == nil:
		dto := importJobDTO(job)
		out.Job = &dto
	case !errors.Is(err, db.ErrNotFound):
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to read the latest import")
		return
	}
	if a.retention != nil {
		days, err := a.retention.ServerDays(r.Context())
		if err != nil {
			slog.Warn("discord import: reading the retention window failed", "error", err)
		}
		out.RetentionDays = days
	}
	writeJSON(w, http.StatusOK, out)
}

func importIDParam(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := pathInt64(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid import id")
		return 0, false
	}
	return id, true
}

// handleStatus answers GET /discord-imports/{id}.
func (a *discordImportAPI) handleStatus(w http.ResponseWriter, r *http.Request) {
	if a.unavailable(w) {
		return
	}
	id, ok := importIDParam(w, r)
	if !ok {
		return
	}
	job, err := a.importer.Status(r.Context(), id)
	if errors.Is(err, db.ErrNotFound) {
		writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "import not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to read the import")
		return
	}
	writeJSON(w, http.StatusOK, importJobDTO(job))
}

// handleCancel answers POST /discord-imports/{id}/cancel. The job ends on its
// own goroutine, so the answer is 202 and the panel polls for the final state.
func (a *discordImportAPI) handleCancel(w http.ResponseWriter, r *http.Request) {
	if a.unavailable(w) {
		return
	}
	id, ok := importIDParam(w, r)
	if !ok {
		return
	}
	job := a.importer.Running(id)
	if job != nil {
		select {
		case <-job.Done():
			job = nil
		default:
		}
	}
	if job == nil {
		if _, err := a.importer.Status(r.Context(), id); errors.Is(err, db.ErrNotFound) {
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "import not found")
			return
		}
		writeErr(w, http.StatusConflict, httperr.CodeConflict, "that import is not running")
		return
	}
	a.cancelMu.Lock()
	a.cancelledBy[id] = actorFromContext(r)
	a.cancelMu.Unlock()
	job.Cancel()
	writeJSON(w, http.StatusAccepted, map[string]any{"id": id, "status": "cancelling"})
}

// uploadQuery reads the file name and optional category of an upload.
func uploadQuery(w http.ResponseWriter, r *http.Request) (name string, categoryID int64, ok bool) {
	q := r.URL.Query()
	name = filepath.Base(strings.ReplaceAll(q.Get("filename"), "\\", "/"))
	switch strings.ToLower(filepath.Ext(name)) {
	case ".json", ".zip":
	default:
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "the export must be a .json or .zip file")
		return "", 0, false
	}
	if raw := q.Get("category_id"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id < 0 {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid category_id")
			return "", 0, false
		}
		categoryID = id
	}
	return name, categoryID, true
}

// handleUpload answers POST /discord-imports/upload. The body is the export
// file itself, streamed to disk; filename and category_id travel in the query.
func (a *discordImportAPI) handleUpload(w http.ResponseWriter, r *http.Request) {
	if a.unavailable(w) {
		return
	}
	name, categoryID, ok := uploadQuery(w, r)
	if !ok {
		return
	}
	if !a.uploading.CompareAndSwap(false, true) {
		writeErr(w, http.StatusConflict, httperr.CodeConflict, "another import is already running")
		return
	}
	defer a.uploading.Store(false)
	// Refuse before receiving gigabytes that a running import would turn away.
	if latest, err := a.importer.Latest(r.Context()); err == nil && a.importer.Running(latest.ID) != nil {
		writeErr(w, http.StatusConflict, httperr.CodeConflict, "another import is already running")
		return
	}
	// A bad category is refused before gigabytes are stored for it.
	if ok, err := a.importer.CategoryExists(r.Context(), categoryID); err != nil {
		slog.Error("discord import: starting failed", "error", err)
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to start the import")
		return
	} else if !ok {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "that category does not exist")
		return
	}
	if r.ContentLength > a.maxBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, httperr.CodePayloadTooLarge, tooLargeMessage(a.maxBytes))
		return
	}

	path, ok := a.spool(w, r, filepath.Ext(name))
	if !ok {
		return
	}
	ex, err := discordimport.OpenFile(path, discordimport.ZipLimits{})
	if err != nil {
		a.discard(path, nil)
		writeImportStartErr(w, err)
		return
	}
	actor := actorFromContext(r)
	job, err := a.importer.Start(r.Context(), discordimport.Request{Export: ex, CategoryID: categoryID, CreatedBy: actor, SourceName: name})
	if err != nil {
		a.discard(path, ex)
		writeImportStartErr(w, err)
		return
	}
	source := auditSource(name)
	db.WriteAudit(context.WithoutCancel(r.Context()), a.audit, actor, "discord_import_start", "channel", job.ChannelID, "started importing "+source)
	a.finishInBackground(r.Context(), job, ex, path, actor, source)
	writeJSON(w, http.StatusAccepted, map[string]any{"id": job.ID, "status": db.ImportRunning})
}

// spool streams the request body into a temp file under the import directory.
// It answers the request itself on failure and then returns ok false.
func (a *discordImportAPI) spool(w http.ResponseWriter, r *http.Request, ext string) (path string, ok bool) {
	var body io.ReadCloser
	if a.begin != nil {
		var release func()
		body, release = a.begin(w, r, a.maxBytes, importTransferLifetime(a.maxBytes))
		defer release()
	} else {
		body = http.MaxBytesReader(w, r.Body, a.maxBytes)
	}
	if err := os.MkdirAll(a.dir, 0o700); err != nil {
		slog.Error("discord import: creating the upload directory failed", "error", err)
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "could not store the upload")
		return "", false
	}
	need := uint64(a.maxBytes) //nolint:gosec // G115: maxBytes is positive
	if r.ContentLength > 0 {
		need = uint64(r.ContentLength)
	}
	if err := checkArchiveSpace(a.dir, need, a.minFree); err != nil {
		writeErr(w, http.StatusInsufficientStorage, httperr.CodeStorageLowDisk, strings.Replace(err.Error(), errArchiveNoSpace.Error(), "not enough free disk space to hold the upload", 1))
		return "", false
	}
	f, err := os.CreateTemp(a.dir, "discord-import-*"+ext)
	if err != nil {
		slog.Error("discord import: creating the upload file failed", "error", err)
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "could not store the upload")
		return "", false
	}
	n, copyErr := io.Copy(f, body)
	closeErr := f.Close()
	if copyErr == nil {
		copyErr = closeErr
	}
	if copyErr == nil && n == 0 {
		copyErr = errEmptyUpload
	}
	if copyErr != nil {
		a.discard(f.Name(), nil)
		var tooBig *http.MaxBytesError
		switch {
		case errors.As(copyErr, &tooBig):
			writeErr(w, http.StatusRequestEntityTooLarge, httperr.CodePayloadTooLarge, tooLargeMessage(a.maxBytes))
		case errors.Is(copyErr, errEmptyUpload):
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "the file is empty")
		default:
			slog.Warn("discord import: receiving the upload failed", "error", copyErr)
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "the upload was interrupted")
		}
		return "", false
	}
	return f.Name(), true
}

var errEmptyUpload = errors.New("empty upload")

func tooLargeMessage(max int64) string {
	return fmt.Sprintf("the export is larger than the %d MB limit (upload.import_max_mb)", max>>20)
}

// discard removes an upload and closes its export when one was opened.
func (a *discordImportAPI) discard(path string, ex discordimport.Export) {
	if ex != nil {
		if err := ex.Close(); err != nil {
			slog.Warn("discord import: closing the export failed", "error", err)
		}
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		slog.Warn("discord import: removing the upload failed", "error", err)
	}
}

// finishInBackground closes the export and removes the upload once the job
// ends, and audits a published or cancelled import. The group joins it at
// shutdown, when it leaves without waiting and the start-up sweep removes the
// file.
func (a *discordImportAPI) finishInBackground(ctx context.Context, job *discordimport.Job, ex discordimport.Export, path string, actor int64, source string) {
	finish := func(ctx context.Context) {
		select {
		case <-job.Done():
		case <-ctx.Done():
			return
		}
		res := job.Wait()
		a.discard(path, ex)
		tail := context.WithoutCancel(ctx)
		a.cancelMu.Lock()
		by, asked := a.cancelledBy[job.ID]
		delete(a.cancelledBy, job.ID)
		a.cancelMu.Unlock()
		switch res.Status {
		case db.ImportDone:
			db.WriteAudit(tail, a.audit, actor, "discord_import_publish", "channel", job.ChannelID,
				fmt.Sprintf("published %s: %d messages imported, %d skipped", source, res.Imported, res.Skipped))
		case db.ImportCancelled:
			if asked {
				db.WriteAudit(tail, a.audit, by, "discord_import_cancel", "channel", job.ChannelID, "cancelled importing "+source)
			}
		}
	}
	if !a.group.Go(ctx, finish) {
		job.Cancel()
		<-job.Done()
		finish(ctx)
	}
}

// auditSource is the upload's file name made safe and short for an audit row.
func auditSource(name string) string {
	s := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	if r := []rune(s); len(r) > maxAuditSourceRunes {
		s = string(r[:maxAuditSourceRunes])
	}
	return s
}

// writeImportStartErr maps an open or start failure onto a response.
func writeImportStartErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, discordimport.ErrImportRunning):
		writeErr(w, http.StatusConflict, httperr.CodeConflict, "another import is already running")
	case errors.Is(err, discordimport.ErrShuttingDown):
		writeErr(w, http.StatusServiceUnavailable, httperr.CodeServiceUnavailable, "the server is shutting down")
	case errors.Is(err, db.ErrNotFound):
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "that category does not exist")
	case errors.Is(err, discordimport.ErrBadExport), errors.Is(err, discordimport.ErrZipTooLarge):
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "not a usable Discord export: "+err.Error())
	default:
		slog.Error("discord import: starting failed", "error", err)
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to start the import")
	}
}
