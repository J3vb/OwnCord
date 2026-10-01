package api

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/go-chi/chi/v5"
)

func handleServeFile(uploads *service.UploadService, store FileStore, allowedOrigins []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		aa, ok := authorizeFileRead(w, r, uploads)
		if !ok {
			return
		}
		f, err := store.Open(aa.StoredAs)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close() //nolint:errcheck
		serveFileContent(w, r, aa, aa.MimeType, fileModTime(f), f, allowedOrigins)
	}
}

// handleServeThumb serves an image file's thumbnail (P4-08): made on the first
// request, then kept beside the original and removed with it (storage.Delete).
// An image the server does not shrink — one already inside thumbBox, a GIF,
// a format it cannot encode, one over thumbMaxPixels or one that does not
// decode — is served as the original. A file that is not an image is a 404.
func handleServeThumb(uploads *service.UploadService, store FileStore, allowedOrigins []string) http.HandlerFunc {
	slots := make(chan struct{}, thumbConcurrency)
	return func(w http.ResponseWriter, r *http.Request) {
		aa, ok := authorizeFileRead(w, r, uploads)
		if !ok {
			return
		}
		if !strings.HasPrefix(aa.MimeType, "image/") {
			http.NotFound(w, r)
			return
		}
		format := thumbFormat(aa.MimeType)
		if format != "" {
			if t, err := store.OpenThumb(aa.StoredAs); err == nil {
				defer t.Close() //nolint:errcheck
				serveFileContent(w, r, aa, aa.MimeType, fileModTime(t), t, allowedOrigins)
				return
			}
		}
		f, err := store.Open(aa.StoredAs)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close() //nolint:errcheck
		var thumb []byte
		if format != "" {
			select {
			case slots <- struct{}{}:
			case <-r.Context().Done():
				return
			}
			thumb, _ = makeThumbnail(f, format)
			<-slots
		}
		if thumb == nil {
			if _, err := f.Seek(0, io.SeekStart); err != nil {
				http.NotFound(w, r)
				return
			}
			serveFileContent(w, r, aa, aa.MimeType, fileModTime(f), f, allowedOrigins)
			return
		}
		keepThumbnail(r.Context(), uploads, store, aa.StoredAs, thumb)
		serveFileContent(w, r, aa, aa.MimeType, time.Now(), bytes.NewReader(thumb), allowedOrigins)
	}
}

// keepThumbnail stores a generated thumbnail for the next request. It is a
// cache, so a failure only costs a regeneration; it still passes the
// disk-headroom floor like every other write into upload storage.
func keepThumbnail(ctx context.Context, uploads *service.UploadService, store FileStore, storedAs string, thumb []byte) {
	res, err := uploads.ReserveHeadroom(ctx, int64(len(thumb)))
	if err != nil {
		return
	}
	defer res.Settle(ctx)
	if err := store.SaveThumb(storedAs, thumb); err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("could not keep a thumbnail", "stored_as", storedAs, "error", err)
		}
		return
	}
	res.Commit()
}

// authorizeFileRead resolves the {id} file and applies its access rule —
// channel read, DM participation, the uploader for an unlinked file, and the
// NSFW acknowledgement — writing the refusal itself when there is one.
func authorizeFileRead(w http.ResponseWriter, r *http.Request, uploads *service.UploadService) (*db.AttachmentAccess, bool) {
	fileID := chi.URLParam(r, "id")
	if fileID == "" {
		http.NotFound(w, r)
		return nil, false
	}
	aa, err := uploads.Resolve(r.Context(), fileID)
	if err != nil {
		writeFileAccessError(w, r, fileID, err)
		return nil, false
	}
	user, _ := r.Context().Value(UserKey).(*db.User)
	role, _ := r.Context().Value(RoleKey).(*db.Role)
	if authErr := uploads.Authorize(r.Context(), aa, user, role); authErr != nil {
		writeFileAccessError(w, r, fileID, authErr)
		return nil, false
	}
	return aa, true
}

// fileModTime is f's modification time, or the zero time when it cannot be
// read (ServeContent then sends no Last-Modified).
func fileModTime(f storage.File) time.Time {
	if info, err := f.Stat(); err == nil {
		return info.ModTime()
	}
	return time.Time{}
}

// serveFileContent writes an authorized file's bytes with the headers every
// file route shares.
func serveFileContent(w http.ResponseWriter, r *http.Request, aa *db.AttachmentAccess, mimeType string, modTime time.Time, content io.ReadSeeker, allowedOrigins []string) {
	// SRV-05: a download longer than the server's global 30 s WriteTimeout
	// is truncated with no error (the client sees a short body). Wrap the
	// writer so every chunk that lands pushes the connection write deadline
	// out; a stalled peer is abandoned after transferProgressTimeout, and
	// any download is closed after transferMaxLifetime.
	deadlines := newTransferDeadline(w, r)
	defer deadlines.release()
	deadlines.touch()
	w = progressWriter{ResponseWriter: w, d: deadlines}

	// Set headers before ServeContent to ensure correct MIME type.
	w.Header().Set("Content-Type", mimeType)
	// BUG-118: Force download for MIME types that could execute content
	// under the OwnCord origin (HTML, SVG, XML, PDF).
	disposition := "inline"
	if isUnsafeInlineMIME(mimeType) {
		disposition = "attachment"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": aa.Filename}))
	// These downloads are access-controlled, so they must never be stored by
	// shared/proxy caches (info-leak). Mark private and force revalidation.
	// W3-4: no-cache forces revalidation on every use, so a max-age is dead
	// weight alongside it — private + no-cache expresses the intent exactly.
	w.Header().Set("Cache-Control", "private, no-cache")
	// The Access-Control-Allow-Origin header below reflects the request
	// Origin, so responses vary by Origin and must not be cross-served.
	w.Header().Set("Vary", "Origin")
	// CORS: allow webview to read the response body using configured origins.
	if origin := r.Header.Get("Origin"); origin != "" {
		for _, allowed := range allowedOrigins {
			if allowed == "*" || strings.EqualFold(allowed, origin) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Expose-Headers", "Content-Type, Content-Length")
				break
			}
		}
	}

	w.Header().Set("X-Content-Type-Options", "nosniff")

	http.ServeContent(w, r, aa.Filename, modTime, content)
}

// writeFileAccessError maps an UploadService refusal onto the response the
// file routes have always given: a missing or tombstoned attachment and one the
// caller may not read are both plain 404/403 bodies that say nothing about
// which rule answered, and anything else is a 500 whose detail stays in the log.
func writeFileAccessError(w http.ResponseWriter, r *http.Request, fileID string, err error) {
	switch {
	case errors.Is(err, service.ErrNotFound):
		http.NotFound(w, r)
	case errors.Is(err, permissions.ErrNSFWUnacknowledged):
		// B5-7: the response carries the code and nothing else — no detail
		// that could distinguish it from any other refusal on this route.
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "NSFW_ACKNOWLEDGEMENT_REQUIRED"})
	case errors.Is(err, service.ErrForbidden):
		writeErr(w, http.StatusForbidden, "FORBIDDEN", "you do not have access to this file")
	default:
		slog.Error("failed to resolve attachment", "id", fileID, "error", err)
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}
}
