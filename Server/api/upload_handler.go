package api

import (
	"bytes"
	"context"
	"errors"
	"image"
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
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// uploadResponse is the JSON shape returned by POST /api/v1/uploads.
type uploadResponse struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	Mime     string `json:"mime"`
	URL      string `json:"url"`
	Width    *int   `json:"width,omitempty"`
	Height   *int   `json:"height,omitempty"`
}

// sanitizeUploadFilename cleans an upload filename: strips control and
// invisible formatting characters, removes path separators, and truncates to a
// safe length.
func sanitizeUploadFilename(name string) string {
	// Strip path components — use only the base name.
	name = filepath.Base(name)
	// filepath.Base only understands the *server* OS's separator, so a
	// backslash survives on a Linux server and is then a path separator on the
	// victim's Windows client, where the name is pre-filled into a save dialog.
	if i := strings.LastIndexByte(name, '\\'); i >= 0 {
		name = name[i+1:]
	}
	// Remove control characters, invisible formatting characters, and any
	// residual forward slash.
	var sb strings.Builder
	for _, r := range name {
		// unicode.Cf covers the bidi overrides (U+202A–U+202E, U+2066–U+2069):
		// invisible characters that reorder how the name renders, so an
		// attachment can display a harmless-looking extension to every other
		// member of the channel while really being an executable script — and
		// the same string is what the native save dialog pre-fills. This is the
		// rule auth.ValidateUsername already applies to usernames.
		//
		// A forward slash is dropped too: filepath.Base("/") returns "/" (root
		// is its own basename), so an upload literally named "/" would otherwise
		// slip through the reserved-name check below with a path separator
		// intact. Any residual '/' is unsafe as a basename, so strip it here.
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf) || r == '/' {
			continue
		}
		sb.WriteRune(r)
	}
	name = strings.TrimSpace(sb.String())
	// Truncate to the filesystem limit. Slicing by byte offset can land in the
	// middle of a multibyte rune, so trim back to the last full rune to keep the
	// result valid UTF-8 (an invalid name misbehaves in JSON encoding, on disk,
	// and in the client's download-name handling).
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

// isUnsafeInlineMIME returns true for MIME types that could execute active
// content (scripts, markup) if served inline under the OwnCord origin.
func isUnsafeInlineMIME(mimeType string) bool {
	// Normalize: take the base type before any parameters (e.g. "text/html; charset=utf-8").
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

// safeStorageErrorMessage maps a storage.Save error to a client-safe
// "upload rejected" body. Full detail always goes to slog.Warn at the call
// site — this only decides what crosses the HTTP boundary. storage.Save's
// failure messages are built with fmt.Errorf("... %s", dst) / %w around
// path-bearing OS errors (creating the file, syncing it, or the destination
// resolving outside the storage dir), so echoing them verbatim hands any
// authenticated user the server's absolute storage layout the moment a save
// fails (disk full, permission change, read-only mount). The two validation
// failures below are the only ones that never embed a path, so they're the
// only ones whose detail is forwarded.
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

// writeStorageSaveError maps a storage.Save failure onto the right HTTP
// class: server-side filesystem failures (storage.ErrIO — disk full,
// permissions, read-only mount) become 507 so they are distinguishable from
// bad uploads in any status dashboard; everything else stays the client's
// 400. Detail never crosses the HTTP boundary either way (path leakage —
// see safeStorageErrorMessage).
func writeStorageSaveError(w http.ResponseWriter, saveErr error, what string) {
	// B5-2: the two bounds refuse with 507 and their own codes, so a client
	// can tell "your quota is full" from "the server is out of disk" from a
	// filesystem failure; none of the three bodies carries a path.
	if errors.Is(saveErr, service.ErrQuotaExceeded) {
		slog.Info(what+" refused: user storage quota", "error", saveErr)
		writeErr(w, http.StatusInsufficientStorage, "STORAGE_QUOTA_EXCEEDED", "upload rejected: your storage quota is full")
		return
	}
	if errors.Is(saveErr, service.ErrLowDisk) {
		slog.Warn("upload refused: server storage below its reserved headroom", "upload", what, "error", saveErr)
		writeErr(w, http.StatusInsufficientStorage, "STORAGE_LOW_DISK", "upload rejected: the server is low on disk space")
		return
	}
	if errors.Is(saveErr, storage.ErrIO) {
		slog.Error("upload failed: server storage error", "upload", what, "error", saveErr)
		writeErr(w, http.StatusInsufficientStorage, "STORAGE_ERROR", "upload failed: server storage error")
		return
	}
	slog.Warn("upload rejected", "upload", what, "error", saveErr)
	writeErr(w, http.StatusBadRequest, "BAD_REQUEST", safeStorageErrorMessage(saveErr))
}

// MountUploadRoutes registers upload and file-serving endpoints.
// allowedOrigins controls the Access-Control-Allow-Origin header on served files.
//
// uploads MUST be non-nil — it owns the access decision on every file
// download and the attachment row behind every upload. A nil service would
// panic on the first request either route saw, so we fail fast at mount time
// rather than let a user find it.
func MountUploadRoutes(r chi.Router, sessions *service.SessionService, store FileStore, limiter *auth.RateLimiter, allowedOrigins []string, uploads *service.UploadService) {
	if uploads == nil {
		panic("api: MountUploadRoutes requires a non-nil UploadService")
	}
	// Upload requires authentication; handleUpload applies its own body cap
	// (uploadBodyCap), which follows upload.max_size_mb.
	r.With(AuthMiddleware(sessions)).Post("/api/v1/uploads", handleUpload(uploads, store, limiter))
	// File serving requires authentication for channel-level access control.
	r.With(AuthMiddleware(sessions)).Get("/api/v1/files/{id}", handleServeFile(uploads, store, allowedOrigins))
	// A bounded preview of an image file, under the same access rule (P4-08).
	r.With(AuthMiddleware(sessions)).Get("/api/v1/files/{id}/thumb", handleServeThumb(uploads, store, allowedOrigins))
}

func handleUpload(uploads *service.UploadService, store FileStore, limiter *auth.RateLimiter) http.HandlerFunc {
	slots := &uploadSlots{n: make(map[int64]int)}
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		// BUG-131: Per-user upload rate limit to prevent disk exhaustion.
		if !limiter.Allow(auth.Key("upload", user.ID), uploadRateLimitPerMinute, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, "RATE_LIMITED", "upload rate limit exceeded, try again later")
			return
		}
		if !slots.acquire(user.ID) {
			writeErr(w, http.StatusTooManyRequests, "RATE_LIMITED", "too many uploads in progress, wait for one to finish")
			return
		}
		defer slots.release(user.ID)

		// SRV-05: the server's global 30 s ReadTimeout/WriteTimeout bound the
		// WHOLE request, so a 25 MB upload on a slow uplink is cut mid-body
		// (and its 201 never lands, because the write deadline elapsed long
		// before the body finished). The route-scoped body wrapper below pushes
		// the connection's read and write deadlines out on every chunk that
		// moves, so a transfer that keeps progressing is not cut before
		// transferMaxLifetime while a peer that stops sending is. The global
		// timeouts are deliberately left alone: they still bound the header
		// phase and slowloris behaviour.
		deadlines := newTransferDeadline(w, r)
		defer deadlines.release()
		deadlines.touch()

		// Limit request body size to prevent abuse.
		fileCap := uploads.MaxUploadBytes()
		r.Body = progressReader{r: http.MaxBytesReader(w, r.Body, uploadBodyCap(fileCap)), d: deadlines}

		// Stream the multipart body instead of buffering or spooling it: no
		// part is read until the bytes it could cost are admitted below.
		mr, err := r.MultipartReader()
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid multipart form")
			return
		}

		// B5-2: admit the bytes before reading any of them. The declared
		// length is untrusted and a chunked request carries none at all
		// (-1), so the envelope is what this request may cost the volume
		// before the true size is known: the declared length when it is
		// sane, otherwise the worst case a single file can ever cost — the
		// configured per-file cap (upload.max_size_mb, already enforced by
		// storage.Storage.Save) when one is set, else the full request cap.
		// A chunked upload otherwise reserves the entire request cap
		// for every user regardless of how small the body turns out to be,
		// which starves anyone whose quota or headroom is smaller than that.
		// The deferred Settle returns the charge on every path that does not
		// reach Record, a panic included.
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
		if err := uploads.Record(r.Context(), service.AttachmentRecord{
			ID:         stored.id,
			UploaderID: user.ID,
			Filename:   safeFilename,
			MimeType:   stored.mime,
			Size:       stored.size,
			Width:      stored.width,
			Height:     stored.height,
		}, res); err != nil {
			// Clean up stored file on DB failure; Settle returns the charge.
			if delErr := store.Delete(stored.id); delErr != nil {
				slog.Error("failed to clean up orphaned upload file", "stored_as", stored.id, "error", delErr)
			}
			slog.Error("failed to create attachment record", "error", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to save attachment")
			return
		}

		slog.Info("file uploaded", "id", stored.id, "filename", safeFilename, "size", stored.size, "mime", stored.mime)

		writeJSON(w, http.StatusCreated, uploadResponse{
			ID:       stored.id,
			Filename: safeFilename,
			Size:     stored.size,
			Mime:     stored.mime,
			URL:      "/api/v1/files/" + stored.id,
			Width:    stored.width,
			Height:   stored.height,
		})
	}
}

// findFilePart walks a multipart request until it finds the "file" field
// carrying an actual file (a filename= attribute — what distinguished
// r.FormFile("file") from a same-named plain value), closing every other
// part without buffering it, and reports the reader's own error (io.EOF
// included) when no such field turns up.
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

// writeUploadPartError maps findFilePart's error onto the response the
// handler always gave: running out of parts without finding "file" is the
// same "missing file field" FormFile gave, and anything else — a malformed
// boundary, truncated headers — is the same "invalid multipart form"
// ParseMultipartForm gave for any structural failure.
func writeUploadPartError(w http.ResponseWriter, err error) {
	if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
		writeErr(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "request body exceeds the upload size limit")
		return
	}
	if errors.Is(err, io.EOF) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "missing file field")
		return
	}
	writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid multipart form")
}

// storedUpload is what the bytes stage of an upload produces: the id the file
// is stored under, the type sniffed from its own bytes, what was written, and
// the image dimensions when it is an image.
type storedUpload struct {
	id, mime      string
	size          int64
	width, height *int
}

// uploadStoreFile is the bytes stage of handleUpload: sniff the type, write the
// file through the store under its reservation, and measure it if it is an
// image. It writes its own error response and reports ok=false, so the caller
// only has to return. Split out of handleUpload to keep that handler under
// the funlen limit; the steps and their order are unchanged.
//
// file is an io.Reader, not multipart.File — a *multipart.Part (the caller's
// argument since the handler moved to streaming) is not seekable, so the
// sniffed header bytes are re-joined with the rest of the stream instead of
// being rewound.
func uploadStoreFile(ctx context.Context, w http.ResponseWriter, file io.Reader, res *service.StorageReservation, store FileStore) (storedUpload, bool) {
	// Generate UUID for storage.
	fileID := uuid.New().String()

	// Detect MIME type from actual file bytes (never trust client header).
	// file is a *multipart.Part in production, and Part.Read may return
	// fewer bytes than requested even when more remain — a genuine short
	// read, not EOF — so io.ReadFull is required here instead of a single
	// Read call to fill the sniff buffer (or hit real EOF/ErrUnexpectedEOF
	// for a file shorter than it).
	var sniffBuf [512]byte
	n, readErr := io.ReadFull(file, sniffBuf[:])
	if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "failed to read uploaded file")
		return storedUpload{}, false
	}
	mime := http.DetectContentType(sniffBuf[:n])
	// Reconstruct the full stream: the sniffed bytes plus the remainder.
	body := io.MultiReader(bytes.NewReader(sniffBuf[:n]), file)

	// Store file on disk (validates file type via magic bytes).
	writtenBytes, saveErr := saveReserved(ctx, res, store, fileID, body)
	if saveErr != nil {
		writeStorageSaveError(w, saveErr, "file upload")
		return storedUpload{}, false
	}

	// Extract image dimensions if the file is an image.
	var width, height *int
	if strings.HasPrefix(mime, "image/") {
		f, openErr := store.Open(fileID)
		if openErr == nil {
			cfg, _, decErr := image.DecodeConfig(f)
			f.Close() //nolint:errcheck
			if decErr == nil {
				w2, h2 := cfg.Width, cfg.Height
				width = &w2
				height = &h2
			} else {
				slog.Warn("failed to decode image dimensions", "id", fileID, "error", decErr)
			}
		}
	}

	return storedUpload{id: fileID, mime: mime, size: writtenBytes, width: width, height: height}, true
}
