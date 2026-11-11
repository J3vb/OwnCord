package api

import (
	"bytes"
	"context"
	"errors"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type uploadResponse struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	Mime     string `json:"mime"`
	URL      string `json:"url"`
	Width    *int   `json:"width,omitempty"`
	Height   *int   `json:"height,omitempty"`
	// DurationMs and Waveform are set only for a voice upload.
	DurationMs int    `json:"duration_ms,omitempty"`
	Waveform   string `json:"waveform,omitempty"`
}

func sanitizeUploadFilename(name string) string {
	name = filepath.Base(name)
	// filepath.Base knows only the server OS's separator, so a backslash survives on Linux and is a path
	// separator on the victim's Windows client, where the name pre-fills a save dialog.
	if i := strings.LastIndexByte(name, '\\'); i >= 0 {
		name = name[i+1:]
	}
	var sb strings.Builder
	for _, r := range name {
		// unicode.Cf covers the bidi overrides, which let an attachment show a harmless extension while being
		// a script (auth.ValidateUsername applies the same rule). A forward slash is dropped too:
		// filepath.Base("/") returns "/", which would slip past the reserved-name check.
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf) || r == '/' {
			continue
		}
		sb.WriteRune(r)
	}
	name = strings.TrimSpace(sb.String())
	// Slicing by byte can split a multibyte rune; trim back to the last full rune to keep valid UTF-8.
	if len(name) > maxUploadFilenameLength {
		name = name[:maxUploadFilenameLength]
		for len(name) > 0 && !utf8.ValidString(name) {
			name = name[:len(name)-1]
		}
	}
	if name == "" || name == "." || name == ".." {
		name = "unnamed"
	}
	return name
}

func isUnsafeInlineMIME(mimeType string) bool {
	base, _, _ := strings.Cut(mimeType, ";")
	base = strings.TrimSpace(strings.ToLower(base))
	switch base {
	case "text/html", "application/xhtml+xml",
		"image/svg+xml", "text/xml", "application/xml",
		"application/pdf",
		"text/xsl", "text/xslt":
		return true
	}
	return false
}

// sniffMIME is http.DetectContentType plus QuickTime and 3GPP (which the WHATWG table leaves out, so a .mov
// would never play inline), and HEIC/HEIF and TIFF, which the thumbnail route previews as JPEG.
func sniffMIME(header []byte) string {
	if len(header) >= 12 && string(header[4:12]) == "ftypqt  " {
		return "video/quicktime"
	}
	if len(header) >= 12 && string(header[4:8]) == "ftyp" &&
		(string(header[8:11]) == "3gp" || string(header[8:11]) == "3g2") {
		return "video/3gpp"
	}
	if m := sniffISOBMFFImage(header); m != "" {
		return m
	}
	if sniffTIFF(header) {
		return mimeTIFF
	}
	return http.DetectContentType(header)
}

// Maps a storage.Save error to a client-safe body; detail goes to slog.Warn at the call site. Save's
// errors wrap path-bearing OS errors that would reveal the storage layout, so only the two validation
// failures below, which never embed a path, are forwarded.
func safeStorageErrorMessage(err error) string {
	msg := err.Error()
	switch {
	case strings.HasPrefix(msg, "blocked file type:"),
		strings.HasPrefix(msg, "file exceeds maximum size"):
		return "upload rejected: " + msg
	default:
		return "upload rejected"
	}
}

// writeStorageSaveError maps storage.ErrIO to 507 so dashboards tell it from bad uploads; everything else
// is 400.
func writeStorageSaveError(w http.ResponseWriter, saveErr error, what string) {
	if writeTransferTimedOut(w, saveErr, what) {
		return
	}
	// Distinct 507 codes let a client tell "your quota is full" from "the server is out of disk"; no body
	// carries a path.
	if errors.Is(saveErr, service.ErrQuotaExceeded) {
		slog.Info(what+" refused: user storage quota", "error", saveErr)
		writeErr(w, http.StatusInsufficientStorage, httperr.CodeStorageQuotaExceeded, "upload rejected: your storage quota is full")
		return
	}
	if errors.Is(saveErr, service.ErrLowDisk) {
		slog.Warn("upload refused: server storage below its reserved headroom", "upload", what, "error", saveErr)
		writeErr(w, http.StatusInsufficientStorage, httperr.CodeStorageLowDisk, "upload rejected: the server is low on disk space")
		return
	}
	if errors.Is(saveErr, storage.ErrIO) {
		slog.Error("upload failed: server storage error", "upload", what, "error", saveErr)
		writeErr(w, http.StatusInsufficientStorage, httperr.CodeStorageError, "upload failed: server storage error")
		return
	}
	slog.Warn("upload rejected", "upload", what, "error", saveErr)
	writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, safeStorageErrorMessage(saveErr))
}

// MountUploadRoutes registers upload and file-serving endpoints; allowedOrigins sets
// Access-Control-Allow-Origin on served files. uploads MUST be non-nil: it owns the access decision on
// every download, so fail fast at mount time.
func MountUploadRoutes(r chi.Router, sessions *service.SessionService, store FileStore, limiter *auth.RateLimiter, allowedOrigins []string, uploads *service.UploadService) {
	if uploads == nil {
		panic("api: MountUploadRoutes requires a non-nil UploadService")
	}
	r.With(AuthMiddleware(sessions)).Post("/api/v1/uploads", handleUpload(uploads, store, limiter))
	r.With(AuthMiddleware(sessions)).Delete("/api/v1/uploads/{id}", handleDiscardUpload(uploads, store))
	// A <video> element cannot send a header, so this route also accepts a short-lived file link; a thumbnail
	// does not.
	links := newFileLinks()
	r.With(fileLinkAuth(sessions, links)).Get("/api/v1/files/{id}", handleServeFile(uploads, store, allowedOrigins))
	r.With(AuthMiddleware(sessions)).Post("/api/v1/files/{id}/link", handleIssueFileLink(uploads, links, limiter))
	r.With(AuthMiddleware(sessions)).Get("/api/v1/files/{id}/thumb", handleServeThumb(uploads, store, allowedOrigins))
}

// handleDiscardUpload deletes the caller's own unsent upload, returning its quota. Anything else is a
// 404, revealing nothing about files the caller does not own.
func handleDiscardUpload(uploads *service.UploadService, store FileStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		fileID := chi.URLParam(r, "id")
		storedAs, err := uploads.Discard(r.Context(), fileID, user.ID)
		if errors.Is(err, service.ErrNotFound) {
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "upload not found")
			return
		}
		if storedAs != "" {
			if delErr := store.Delete(storedAs); delErr != nil {
				slog.Error("failed to delete discarded upload", "stored_as", storedAs, "error", delErr)
			}
		}
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleUpload(uploads *service.UploadService, store FileStore, limiter *auth.RateLimiter) http.HandlerFunc {
	slots := newUploadSlots(maxConcurrentUploadsPerUser)
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		if !limiter.Allow(auth.Key("upload", user.ID), uploadRateLimitPerMinute, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "upload rate limit exceeded, try again later")
			return
		}
		if !slots.acquire(user.ID) {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "too many uploads in progress, wait for one to finish")
			return
		}
		defer slots.release(user.ID)

		// Validated before any quota is reserved or a body byte is read.
		voice, err := parseVoiceMeta(r.URL.Query())
		if err != nil {
			writeVoiceParamError(w, err)
			return
		}

		// The global 30 s Read/WriteTimeout would cut a slow-uplink upload mid-body. The route-scoped wrapper
		// pushes the deadlines out on every chunk that moves, so a progressing transfer survives until its
		// lifetime and a stalled peer does not; the global timeouts still bound the header phase and
		// slowloris.
		fileCap := uploads.MaxUploadBytes()
		release := transferBody(w, r, uploadBodyCap(fileCap))
		defer release()

		// Stream the multipart body: no part is read until the bytes it could cost are admitted.
		mr, err := r.MultipartReader()
		if err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid multipart form")
			return
		}

		// The declared length is untrusted and a chunked request carries none (-1), so reserve the declared
		// length when sane, else the worst case one file can cost; reserving the whole request cap would
		// starve users with less quota. The deferred Settle returns the charge on every path that skips
		// Record, a panic included.
		worstCase := fileCap
		if worstCase <= 0 {
			worstCase = uploadMaxBodySize
		}
		envelope := r.ContentLength
		if envelope <= 0 || envelope > worstCase {
			envelope = worstCase
		}
		res, err := uploads.Reserve(r.Context(), user.ID, envelope)
		if err != nil {
			writeStorageSaveError(w, err, "file upload")
			return
		}
		defer res.Settle(r.Context())

		part, err := findFilePart(mr)
		if err != nil {
			writeUploadPartError(w, err)
			return
		}
		defer part.Close() //nolint:errcheck

		// The owner's file-type policy judges the name the file will carry; storage.Save's content blocks
		// still apply.
		safeFilename := sanitizeUploadFilename(part.FileName())
		if !checkUploadFileType(r.Context(), w, uploads, safeFilename) {
			return
		}
		stored, ok := uploadStoreFile(r.Context(), w, part, res, store)
		if !ok {
			return
		}
		if !voice.checkStored(w, store, stored) {
			return
		}

		// The tail meets the body cap and the multipart parser too, so a padded or malformed tail refuses the
		// upload.
		if err := drainMultipartTail(mr); err != nil {
			if delErr := store.Delete(stored.id); delErr != nil {
				slog.Error("failed to clean up refused upload file", "stored_as", stored.id, "error", delErr)
			}
			writeUploadPartError(w, err)
			return
		}

		rec := voice.record(user.ID, safeFilename, stored)
		if err := uploads.Record(r.Context(), rec, res); err != nil {
			if delErr := store.Delete(stored.id); delErr != nil {
				slog.Error("failed to clean up orphaned upload file", "stored_as", stored.id, "error", delErr)
			}
			slog.Error("failed to create attachment record", "error", err)
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to save attachment")
			return
		}

		slog.Info("file uploaded", "id", stored.id, "filename", safeFilename, "size", stored.size, "mime", stored.mime)

		writeJSON(w, http.StatusCreated, uploadResponse{
			ID:         stored.id,
			Filename:   safeFilename,
			Size:       stored.size,
			Mime:       stored.mime,
			URL:        "/api/v1/files/" + stored.id,
			Width:      stored.width,
			Height:     stored.height,
			DurationMs: voice.durationMs,
			Waveform:   voice.waveform,
		})
	}
}

// findFilePart finds the "file" field carrying a filename= (not a same-named plain value), closing other
// parts unbuffered. It returns the reader's error (io.EOF included) when none is found.
func findFilePart(mr *multipart.Reader) (*multipart.Part, error) {
	for {
		part, err := mr.NextPart()
		if err != nil {
			return nil, err
		}
		if part.FormName() == "file" && part.FileName() != "" {
			return part, nil
		}
		part.Close() //nolint:errcheck
	}
}

func drainMultipartTail(mr *multipart.Reader) error {
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err := io.Copy(io.Discard, p); err != nil {
			return err
		}
	}
}

// writeUploadPartError: no "file" part is "missing file field"; any structural failure is "invalid
// multipart form".
func writeUploadPartError(w http.ResponseWriter, err error) {
	if writeTransferTimedOut(w, err, "file upload") {
		return
	}
	if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
		writeErr(w, http.StatusRequestEntityTooLarge, httperr.CodePayloadTooLarge, "request body exceeds the upload size limit")
		return
	}
	if errors.Is(err, io.EOF) {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "missing file field")
		return
	}
	writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid multipart form")
}

// storedUpload is what the bytes stage produces: stored id, sniffed type, bytes written and image
// dimensions.
type storedUpload struct {
	id, mime      string
	size          int64
	width, height *int
}

// uploadStoreFile sniffs the type, writes through the store under its reservation and measures images. It
// writes its own error response and reports ok=false. file is an io.Reader because a *multipart.Part is
// not seekable, so sniffed bytes are re-joined rather than rewound.
func uploadStoreFile(ctx context.Context, w http.ResponseWriter, file io.Reader, res *service.StorageReservation, store FileStore) (storedUpload, bool) {
	fileID := uuid.New().String()

	// Sniff the actual bytes, never the client header. Part.Read may return short without EOF, so use
	// io.ReadFull.
	var sniffBuf [512]byte
	n, readErr := io.ReadFull(file, sniffBuf[:])
	if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
		if writeTransferTimedOut(w, readErr, "file upload") {
			return storedUpload{}, false
		}
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "failed to read uploaded file")
		return storedUpload{}, false
	}
	mime := sniffMIME(sniffBuf[:n])
	body := io.MultiReader(bytes.NewReader(sniffBuf[:n]), file)

	writtenBytes, saveErr := saveReserved(ctx, res, store, fileID, body)
	if saveErr != nil {
		writeStorageSaveError(w, saveErr, "file upload")
		return storedUpload{}, false
	}

	mime, width, height := inspectStoredImage(store, fileID, mime)
	return storedUpload{id: fileID, mime: mime, size: writtenBytes, width: width, height: height}, true
}

// jpegSidewaysOnDisk reports whether EXIF orientation 5-8 swaps width and height, as thumbnails and
// browsers display it.
func jpegSidewaysOnDisk(f io.ReadSeeker) bool {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return false
	}
	o, _ := jpegHeader(f)
	return o >= 5 && o <= 8
}
