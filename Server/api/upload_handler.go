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

// sanitizeUploadFilename strips control and invisible formatting characters and
// path separators, and truncates to a safe length.
func sanitizeUploadFilename(name string) string {
	name = filepath.Base(name)
	// filepath.Base only understands the *server* OS's separator, so a
	// backslash survives on a Linux server and is then a path separator on the
	// victim's Windows client, where the name is pre-filled into a save dialog.
	if i := strings.LastIndexByte(name, '\\'); i >= 0 {
		name = name[i+1:]
	}
	var sb strings.Builder
	for _, r := range name {
		// unicode.Cf covers the bidi overrides (U+202A-U+202E, U+2066-U+2069),
		// which reorder how a name renders so an attachment can show a harmless
		// extension while being a script, and the native save dialog pre-fills
		// the same string. auth.ValidateUsername applies the same rule.
		// A forward slash is dropped too: filepath.Base("/") returns "/", so an
		// upload named "/" would otherwise slip past the reserved-name check
		// below with a separator intact.
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf) || r == '/' {
			continue
		}
		sb.WriteRune(r)
	}
	name = strings.TrimSpace(sb.String())
	// Slicing by byte can split a multibyte rune, so trim back to the last full
	// rune to keep valid UTF-8 (an invalid name misbehaves in JSON, on disk and
	// in the client's download-name handling).
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

// isUnsafeInlineMIME reports MIME types that could run active content if served
// inline under the OwnCord origin.
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

// sniffMIME is http.DetectContentType plus QuickTime and 3GPP, which the WHATWG
// table leaves out (a .mov with the "qt  " brand would be stored as
// application/octet-stream and never play inline). It also names HEIC/HEIF and
// TIFF, which the thumbnail route previews as JPEG.
func sniffMIME(header []byte) string {
	if len(header) >= 12 && string(header[4:12]) == "ftypqt  " {
		return "video/quicktime"
	}
	// 3GPP and 3GPP2 clips carry a "3gp*" / "3g2*" major brand, which the
	// WHATWG table does not know either.
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

// safeStorageErrorMessage maps a storage.Save error to a client-safe body;
// detail goes to slog.Warn at the call site. Save's errors wrap path-bearing OS
// errors, so echoing them would hand any authenticated user the server's storage
// layout. Only the two validation failures below never embed a path, so only
// their detail is forwarded.
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

// writeStorageSaveError maps a storage.Save failure to an HTTP class:
// server-side filesystem failures (storage.ErrIO) become 507 so status
// dashboards tell them from bad uploads; everything else is 400. Detail never
// crosses the boundary (see safeStorageErrorMessage).
func writeStorageSaveError(w http.ResponseWriter, saveErr error, what string) {
	// The two bounds refuse with 507 and their own codes so a client can tell
	// "your quota is full" from "the server is out of disk" from a filesystem
	// failure; no body carries a path.
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

// MountUploadRoutes registers upload and file-serving endpoints; allowedOrigins
// sets Access-Control-Allow-Origin on served files. uploads MUST be non-nil: it
// owns the access decision on every download and the attachment row behind every
// upload, so fail fast at mount time.
func MountUploadRoutes(r chi.Router, sessions *service.SessionService, store FileStore, limiter *auth.RateLimiter, allowedOrigins []string, uploads *service.UploadService) {
	if uploads == nil {
		panic("api: MountUploadRoutes requires a non-nil UploadService")
	}
	// handleUpload applies its own body cap (uploadBodyCap), which follows
	// upload.max_size_mb.
	r.With(AuthMiddleware(sessions)).Post("/api/v1/uploads", handleUpload(uploads, store, limiter))
	r.With(AuthMiddleware(sessions)).Delete("/api/v1/uploads/{id}", handleDiscardUpload(uploads, store))
	// A <video> element cannot send a header, so this one route also accepts a
	// short-lived file link (file_link.go); a thumbnail does not.
	links := newFileLinks()
	r.With(fileLinkAuth(sessions, links)).Get("/api/v1/files/{id}", handleServeFile(uploads, store, allowedOrigins))
	r.With(AuthMiddleware(sessions)).Post("/api/v1/files/{id}/link", handleIssueFileLink(uploads, links, limiter))
	r.With(AuthMiddleware(sessions)).Get("/api/v1/files/{id}/thumb", handleServeThumb(uploads, store, allowedOrigins))
}

// handleDiscardUpload deletes the caller's own upload that no message holds,
// returning its quota. Anything else (unknown, another user's, already sent, a
// live avatar) is a 404, revealing nothing about files the caller does not own.
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
	slots := &uploadSlots{n: make(map[int64]int)}
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

		// The voice pair is validated before any quota is reserved and
		// before a byte of the body is read.
		voice, err := parseVoiceMeta(r.URL.Query())
		if err != nil {
			writeVoiceParamError(w, err)
			return
		}

		// The global 30 s Read/WriteTimeout bound the WHOLE request, so a 25 MB
		// upload on a slow uplink is cut mid-body and its 201 never lands. The
		// route-scoped body wrapper pushes the read and write deadlines out on
		// every chunk that moves, so a progressing transfer survives until
		// transferMaxLifetime and a stalled peer does not. The global timeouts
		// stay: they still bound the header phase and slowloris.
		deadlines := newTransferDeadline(w, r)
		defer deadlines.release()
		deadlines.touch()

		fileCap := uploads.MaxUploadBytes()
		r.Body = progressReader{r: http.MaxBytesReader(w, r.Body, uploadBodyCap(fileCap)), d: deadlines}

		// Stream the multipart body instead of buffering or spooling it: no
		// part is read until the bytes it could cost are admitted below.
		mr, err := r.MultipartReader()
		if err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid multipart form")
			return
		}

		// Admit the bytes before reading any. The declared length is untrusted
		// and a chunked request carries none (-1), so reserve the envelope: the
		// declared length when sane, else the worst case one file can cost (the
		// per-file cap upload.max_size_mb when set, else the request cap).
		// Reserving the whole request cap for every chunked upload would starve
		// users with smaller quota or headroom. The deferred Settle returns the
		// charge on every path that does not reach Record, a panic included.
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

		// The owner's file-type policy judges the name the file will carry;
		// storage.Save's content blocks still apply to whatever it allows.
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

		// Drain the rest of the body: the tail meets the body cap and the
		// multipart parser too, so a padded or malformed tail refuses the
		// upload instead of riding in behind the file part.
		if err := drainMultipartTail(mr); err != nil {
			if delErr := store.Delete(stored.id); delErr != nil {
				slog.Error("failed to clean up refused upload file", "stored_as", stored.id, "error", delErr)
			}
			writeUploadPartError(w, err)
			return
		}

		// Record the attachment (unlinked — message_id is NULL) and commit
		// the reservation under the same lock.
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

// findFilePart walks a multipart request to the "file" field carrying an actual
// file (a filename= attribute, which distinguishes it from a same-named plain
// value), closing other parts unbuffered. It returns the reader's error (io.EOF
// included) when none is found.
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

// drainMultipartTail reads every part after the file to its end, discarding
// the bytes, and reports the first error the reader or the body cap raises.
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

// writeUploadPartError keeps the handler's old responses: no "file" part is
// "missing file field", and any structural failure (malformed boundary,
// truncated headers) is "invalid multipart form".
func writeUploadPartError(w http.ResponseWriter, err error) {
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

// storedUpload is what the bytes stage of an upload produces: the id the file
// is stored under, the type sniffed from its own bytes, what was written, and
// the image dimensions when it is an image.
type storedUpload struct {
	id, mime      string
	size          int64
	width, height *int
}

// uploadStoreFile is the bytes stage of handleUpload: sniff the type, write
// through the store under its reservation, and measure images. It writes its own
// error response and reports ok=false. file is an io.Reader because a
// *multipart.Part is not seekable, so the sniffed header bytes are re-joined
// with the stream rather than rewound.
func uploadStoreFile(ctx context.Context, w http.ResponseWriter, file io.Reader, res *service.StorageReservation, store FileStore) (storedUpload, bool) {
	fileID := uuid.New().String()

	// Detect the MIME type from the actual bytes, never the client header.
	// Part.Read may return short without EOF, so io.ReadFull fills the sniff
	// buffer.
	var sniffBuf [512]byte
	n, readErr := io.ReadFull(file, sniffBuf[:])
	if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
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

	// A TIFF-structured camera RAW is a download; an image gets its upright size.
	mime, width, height := inspectStoredImage(store, fileID, mime)
	return storedUpload{id: fileID, mime: mime, size: writtenBytes, width: width, height: height}, true
}

// jpegSidewaysOnDisk reports whether f's EXIF orientation (5-8) turns the
// stored image a quarter turn, so the upright size swaps width and height,
// as the thumbnail route and browsers display it.
func jpegSidewaysOnDisk(f io.ReadSeeker) bool {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return false
	}
	o, _ := jpegHeader(f)
	return o >= 5 && o <= 8
}
