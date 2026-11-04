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
	"strconv"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
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

// handleServeThumb serves an image's thumbnail: made on first request, then kept
// beside the original and removed with it (storage.Delete). An image the server
// does not shrink (already inside thumbBox, a GIF, an animated WebP, a format
// with no decoder, over thumbMaxDecodeBytes, or undecodable) is served as the
// original, and a failed generation is kept as an empty thumbnail so it is never
// retried. A request that finds no free slot within thumbSlotWait is served the
// original without keeping anything, so a later request still makes the
// thumbnail. A non-image is a 404. HEIC, HEIF and TIFF previews are always a
// JPEG and a failed conversion is a 404 (serveConvertedPreview).
func handleServeThumb(uploads *service.UploadService, store FileStore, allowedOrigins []string) http.HandlerFunc {
	slots := newThumbSlots()
	return func(w http.ResponseWriter, r *http.Request) {
		aa, ok := authorizeFileRead(w, r, uploads)
		if !ok {
			return
		}
		if !strings.HasPrefix(aa.MimeType, "image/") {
			http.NotFound(w, r)
			return
		}
		if format := convertedFormat(aa.MimeType); format != "" {
			serveConvertedPreview(w, r, aa, uploads, store, slots, format, allowedOrigins)
			return
		}
		format := thumbFormat(aa.MimeType)
		passThrough := format == ""
		if !passThrough {
			t, found := keptThumb(store, aa.StoredAs)
			if t != nil {
				serveKeptThumb(w, r, aa, t, allowedOrigins)
				return
			}
			passThrough = found
		}
		f, err := store.Open(aa.StoredAs)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close() //nolint:errcheck
		var thumb []byte
		if !passThrough {
			var kept storage.File
			if thumb, kept, ok = generateThumb(r, uploads, store, slots, aa.StoredAs, f, format); !ok {
				return
			}
			if kept != nil {
				serveKeptThumb(w, r, aa, kept, allowedOrigins)
				return
			}
		}
		if thumb == nil {
			if _, err := f.Seek(0, io.SeekStart); err != nil {
				http.NotFound(w, r)
				return
			}
			serveFileContent(w, r, aa, aa.MimeType, fileModTime(f), f, allowedOrigins)
			return
		}
		serveFileContent(w, r, aa, thumbMIME(aa.MimeType, thumb), time.Now(), bytes.NewReader(thumb), allowedOrigins)
	}
}

// generateThumb makes and keeps the thumbnail of the original f under a slot.
// It returns the new thumbnail, or one another request kept while this one
// waited for the slot, or neither when the original is to be served: it is not
// thumbnailed, it did not decode, or no slot came free in time. ok is false
// only when the request ended while waiting.
func generateThumb(r *http.Request, uploads *service.UploadService, store FileStore, slots *thumbSlots, storedAs string, f storage.File, format string) (thumb []byte, kept storage.File, ok bool) {
	orientation, accepted := thumbOrientation(f, format)
	if !accepted {
		return nil, nil, true
	}
	release, got := slots.acquire(r.Context(), 1)
	if !got {
		return nil, nil, r.Context().Err() == nil
	}
	defer release()
	kept, found := keptThumb(store, storedAs)
	if found {
		return nil, kept, true
	}
	thumb, _ = makeThumbnail(f, format, orientation)
	keepThumbnail(r.Context(), uploads, store, storedAs, thumb)
	return thumb, nil, true
}

// serveKeptThumb serves a kept thumbnail and closes it. A WebP's thumbnail is a
// JPEG or a PNG, told apart by its first bytes.
func serveKeptThumb(w http.ResponseWriter, r *http.Request, aa *db.AttachmentAccess, t storage.File, allowedOrigins []string) {
	defer t.Close() //nolint:errcheck
	mimeType := aa.MimeType
	if mimeType == mimeWebP {
		var head [8]byte
		n, _ := io.ReadFull(t, head[:])
		if _, err := t.Seek(0, io.SeekStart); err != nil {
			http.NotFound(w, r)
			return
		}
		mimeType = thumbMIME(mimeType, head[:n])
	}
	serveFileContent(w, r, aa, mimeType, fileModTime(t), t, allowedOrigins)
}

// serveConvertedPreview answers the thumbnail route for a HEIC, HEIF or TIFF
// original: always a JPEG, even for a picture inside thumbBox, because no
// webview shows the original. It is generated once under the same slots as other
// thumbnails (a HEIC holds heicSlotWeight of them) and kept; a failed or refused
// conversion is kept as an empty thumbnail and answered 404 from then on, so it
// is decoded at most once and the original is never served as an image. A
// request that finds no free slot in time is answered 503 with a Retry-After,
// and nothing is kept.
func serveConvertedPreview(w http.ResponseWriter, r *http.Request, aa *db.AttachmentAccess, uploads *service.UploadService, store FileStore, slots *thumbSlots, format string, allowedOrigins []string) {
	serveKept := func(t storage.File) {
		defer t.Close() //nolint:errcheck
		serveFileContent(w, r, aa, convertedPreviewMIME, fileModTime(t), t, allowedOrigins)
	}
	t, found := keptThumb(store, aa.StoredAs)
	if t != nil {
		serveKept(t)
		return
	}
	if found {
		http.NotFound(w, r)
		return
	}
	f, err := store.Open(aa.StoredAs)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close() //nolint:errcheck
	weight := int64(1)
	if format == "heic" {
		weight = heicSlotWeight
	}
	release, got := slots.acquire(r.Context(), weight)
	if !got {
		if r.Context().Err() == nil {
			w.Header().Set("Retry-After", strconv.Itoa(int(thumbSlotWait/time.Second)))
			writeErr(w, http.StatusServiceUnavailable, httperr.CodeServiceUnavailable, "the server is busy making previews; try again shortly")
		}
		return
	}
	// A request that waited for the slot may find the preview already made.
	t, found = keptThumb(store, aa.StoredAs)
	var preview []byte
	if t == nil && !found {
		var convErr error
		preview, convErr = makeConvertedPreview(f, format)
		if convErr != nil {
			slog.Warn("could not convert an image preview", "stored_as", aa.StoredAs, "error", convErr)
		}
		keepThumbnail(r.Context(), uploads, store, aa.StoredAs, preview)
	}
	release()
	switch {
	case t != nil:
		serveKept(t)
	case preview != nil:
		serveFileContent(w, r, aa, convertedPreviewMIME, time.Now(), bytes.NewReader(preview), allowedOrigins)
	default:
		http.NotFound(w, r)
	}
}

// keptThumb reports what is kept for the original storedAs: its thumbnail (t),
// an empty one recording that the original is served instead (t nil, found), or
// nothing yet.
func keptThumb(store FileStore, storedAs string) (t storage.File, found bool) {
	t, err := store.OpenThumb(storedAs)
	if err != nil {
		return nil, false
	}
	info, err := t.Stat()
	if err == nil && info.Size() > 0 {
		return t, true
	}
	_ = t.Close()
	return nil, err == nil
}

// keepThumbnail stores a generated thumbnail for the next request, or an empty
// one when generation failed. It is a cache, so a failure only costs a
// regeneration; it still passes the disk-headroom floor like every write into
// upload storage.
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

// authorizeFileRead resolves the {id} file and applies its access rule (channel
// read, DM participation, the uploader for an unlinked file, NSFW
// acknowledgement), writing the refusal itself.
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

// fileModTime is f's modification time, or zero when unreadable (ServeContent
// then sends no Last-Modified).
func fileModTime(f storage.File) time.Time {
	if info, err := f.Stat(); err == nil {
		return info.ModTime()
	}
	return time.Time{}
}

func serveFileContent(w http.ResponseWriter, r *http.Request, aa *db.AttachmentAccess, mimeType string, modTime time.Time, content io.ReadSeeker, allowedOrigins []string) {
	// A download longer than the global 30 s WriteTimeout is truncated with no
	// error. Wrap the writer so every chunk that lands pushes the write deadline
	// out; a stalled peer is abandoned after transferProgressTimeout and a
	// download closes after the lifetime its file size earns. A cut download
	// has no way to answer: net/http closes the connection and the client sees
	// fewer bytes than Content-Length.
	deadlines := newTransferDeadline(w, r, aa.Size)
	defer deadlines.release()
	defer func() {
		if deadlines.timedOut() {
			slog.Info("file download cut by the transfer deadline", "id", aa.ID)
		}
	}()
	deadlines.touch()
	w = progressWriter{ResponseWriter: w, d: deadlines}

	w.Header().Set("Content-Type", mimeType)
	// Force download for MIME types that could execute content under the OwnCord
	// origin (HTML, SVG, XML, PDF).
	disposition := "inline"
	if isUnsafeInlineMIME(mimeType) {
		disposition = "attachment"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": aa.Filename}))
	// These downloads are access-controlled, so shared/proxy caches must never
	// store them: private + no-cache forces revalidation on every use, which
	// makes a max-age dead weight.
	w.Header().Set("Cache-Control", "private, no-cache")
	// Access-Control-Allow-Origin below reflects the request Origin, so
	// responses vary by Origin and must not be cross-served.
	w.Header().Set("Vary", "Origin")
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

// writeFileAccessError maps an UploadService refusal onto the file routes'
// responses: a missing or tombstoned attachment and one the caller may not read
// are both plain 404/403 bodies that do not say which rule answered; anything
// else is a 500 whose detail stays in the log.
func writeFileAccessError(w http.ResponseWriter, r *http.Request, fileID string, err error) {
	switch {
	case errors.Is(err, service.ErrNotFound):
		http.NotFound(w, r)
	case errors.Is(err, permissions.ErrNSFWUnacknowledged):
		// The response carries the code and nothing else, so it cannot be told
		// apart from any other refusal on this route.
		writeErr(w, http.StatusForbidden, httperr.CodeNSFWAcknowledgementRequired, "")
	case errors.Is(err, service.ErrForbidden):
		writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "you do not have access to this file")
	default:
		slog.Error("failed to resolve attachment", "id", fileID, "error", err)
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "internal server error")
	}
}
