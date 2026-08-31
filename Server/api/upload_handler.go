package api

import (
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
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
	base := strings.SplitN(mimeType, ";", 2)[0]
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
	if errors.Is(saveErr, storage.ErrIO) {
		slog.Error(what+" failed: server storage error", "error", saveErr)
		writeJSON(w, http.StatusInsufficientStorage, errorResponse{
			Error:   "STORAGE_ERROR",
			Message: "upload failed: server storage error",
		})
		return
	}
	slog.Warn(what+" rejected", "error", saveErr)
	writeJSON(w, http.StatusBadRequest, errorResponse{
		Error:   "BAD_REQUEST",
		Message: safeStorageErrorMessage(saveErr),
	})
}

// MountUploadRoutes registers upload and file-serving endpoints.
// allowedOrigins controls the Access-Control-Allow-Origin header on served files.
//
// uploads MUST be non-nil — it owns the access decision on every file
// download and the attachment row behind every upload. A nil service would
// panic on the first request either route saw, so we fail fast at mount time
// rather than let a user find it.
func MountUploadRoutes(r chi.Router, database *db.DB, store FileStore, limiter *auth.RateLimiter, allowedOrigins []string, uploads *service.UploadService) {
	if uploads == nil {
		panic("api: MountUploadRoutes requires a non-nil UploadService")
	}
	// Upload requires authentication and a higher body size limit (100 MB).
	r.With(
		AuthMiddleware(database),
		MaxBodySize(uploadMaxBodySize),
	).Post("/api/v1/uploads", handleUpload(uploads, store, limiter))
	// File serving requires authentication for channel-level access control.
	r.With(AuthMiddleware(database)).Get("/api/v1/files/{id}", handleServeFile(uploads, store, allowedOrigins))
}

func handleUpload(uploads *service.UploadService, store FileStore, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// BUG-131: Per-user upload rate limit to prevent disk exhaustion.
		user, ok := r.Context().Value(UserKey).(*db.User)
		if ok && user != nil {
			uploadKey := auth.Key("upload", user.ID)
			if !limiter.Allow(uploadKey, uploadRateLimitPerMinute, time.Minute) {
				writeJSON(w, http.StatusTooManyRequests, errorResponse{
					Error:   "RATE_LIMITED",
					Message: "upload rate limit exceeded, try again later",
				})
				return
			}
		}

		// Limit request body size to prevent abuse.
		r.Body = http.MaxBytesReader(w, r.Body, uploadMaxBodySize)

		// Parse multipart form — 10 MB in memory, rest on disk.
		if err := r.ParseMultipartForm(multipartMemoryLimit); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: "invalid multipart form",
			})
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: "missing file field",
			})
			return
		}
		defer file.Close() //nolint:errcheck

		stored, ok := uploadStoreFile(w, file, store)
		if !ok {
			return
		}

		// Record the attachment (unlinked — message_id is NULL).
		user, _ = r.Context().Value(UserKey).(*db.User)
		safeFilename := sanitizeUploadFilename(header.Filename)
		if err := uploads.Record(r.Context(), service.AttachmentRecord{
			ID:         stored.id,
			UploaderID: user.ID,
			Filename:   safeFilename,
			MimeType:   stored.mime,
			Size:       stored.size,
			Width:      stored.width,
			Height:     stored.height,
		}); err != nil {
			// Clean up stored file on DB failure.
			_ = store.Delete(stored.id)
			slog.Error("failed to create attachment record", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to save attachment",
			})
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

func handleServeFile(uploads *service.UploadService, store FileStore, allowedOrigins []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fileID := chi.URLParam(r, "id")
		if fileID == "" {
			http.NotFound(w, r)
			return
		}

		aa, err := uploads.Resolve(r.Context(), fileID)
		if err != nil {
			writeFileAccessError(w, r, fileID, err)
			return
		}

		user, _ := r.Context().Value(UserKey).(*db.User)
		role, _ := r.Context().Value(RoleKey).(*db.Role)
		if authErr := uploads.Authorize(r.Context(), aa, user, role); authErr != nil {
			writeFileAccessError(w, r, fileID, authErr)
			return
		}

		// Open file from storage.
		f, err := store.Open(aa.StoredAs)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close() //nolint:errcheck

		// Set headers before ServeContent to ensure correct MIME type.
		w.Header().Set("Content-Type", aa.MimeType)
		// BUG-118: Force download for MIME types that could execute content
		// under the OwnCord origin (HTML, SVG, XML, PDF).
		disposition := "inline"
		if isUnsafeInlineMIME(aa.MimeType) {
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

		// Use the actual file modification time so If-Modified-Since works correctly.
		var modTime time.Time
		if info, statErr := f.Stat(); statErr == nil {
			modTime = info.ModTime()
		}
		http.ServeContent(w, r, aa.Filename, modTime, f)
	}
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
// file through the store, and measure it if it is an image. It writes its own
// error response and reports ok=false, so the caller only has to return.
// Split out of handleUpload to keep that handler under the funlen limit; the
// steps and their order are unchanged.
func uploadStoreFile(w http.ResponseWriter, file multipart.File, store FileStore) (storedUpload, bool) {
	// Generate UUID for storage.
	fileID := uuid.New().String()

	// Detect MIME type from actual file bytes (never trust client header).
	var sniffBuf [512]byte
	n, readErr := file.Read(sniffBuf[:])
	if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error:   "BAD_REQUEST",
			Message: "failed to read uploaded file",
		})
		return storedUpload{}, false
	}
	mime := http.DetectContentType(sniffBuf[:n])
	// Seek back so the full content is available for storage.
	if _, seekErr := file.Seek(0, 0); seekErr != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{
			Error:   "INTERNAL_ERROR",
			Message: "failed to process uploaded file",
		})
		return storedUpload{}, false
	}

	// Store file on disk (validates file type via magic bytes).
	writtenBytes, saveErr := store.Save(fileID, file)
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

// writeFileAccessError maps an UploadService refusal onto the response the
// file routes have always given: a missing or tombstoned attachment and one the
// caller may not read are both plain 404/403 bodies that say nothing about
// which rule answered, and anything else is a 500 whose detail stays in the log.
func writeFileAccessError(w http.ResponseWriter, r *http.Request, fileID string, err error) {
	switch {
	case errors.Is(err, service.ErrNotFound):
		http.NotFound(w, r)
	case errors.Is(err, service.ErrForbidden):
		writeJSON(w, http.StatusForbidden, errorResponse{
			Error:   "FORBIDDEN",
			Message: "you do not have access to this file",
		})
	default:
		slog.Error("failed to resolve attachment", "id", fileID, "error", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{
			Error:   "INTERNAL_ERROR",
			Message: "internal server error",
		})
	}
}
