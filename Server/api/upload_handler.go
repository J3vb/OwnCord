package api

import (
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/storage"
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

// sanitizeUploadFilename cleans an upload filename: strips control characters,
// removes path separators, and truncates to a safe length.
func sanitizeUploadFilename(name string) string {
	// Strip path components — use only the base name.
	name = filepath.Base(name)
	// Remove control characters.
	var sb strings.Builder
	for _, r := range name {
		if r >= 32 && r != 127 { // exclude control chars and DEL
			sb.WriteRune(r)
		}
	}
	name = strings.TrimSpace(sb.String())
	// Truncate to 255 characters (filesystem limit).
	if len(name) > maxUploadFilenameLength {
		name = name[:maxUploadFilenameLength]
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

// MountUploadRoutes registers upload and file-serving endpoints.
// allowedOrigins controls the Access-Control-Allow-Origin header on served files.
func MountUploadRoutes(r chi.Router, database *db.DB, store *storage.Storage, limiter *auth.RateLimiter, allowedOrigins []string) {
	// Upload requires authentication and a higher body size limit (100 MB).
	r.With(
		AuthMiddleware(database),
		MaxBodySize(uploadMaxBodySize),
	).Post("/api/v1/uploads", handleUpload(database, store, limiter))
	// File serving requires authentication for channel-level access control.
	r.With(AuthMiddleware(database)).Get("/api/v1/files/{id}", handleServeFile(database, store, allowedOrigins))
}

func handleUpload(database *db.DB, store *storage.Storage, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// BUG-131: Per-user upload rate limit to prevent disk exhaustion.
		user, ok := r.Context().Value(UserKey).(*db.User)
		if ok && user != nil {
			uploadKey := fmt.Sprintf("upload:%d", user.ID)
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
			return
		}
		detectedMime := http.DetectContentType(sniffBuf[:n])
		// Seek back so the full content is available for storage.
		if _, seekErr := file.Seek(0, 0); seekErr != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to process uploaded file",
			})
			return
		}
		mime := detectedMime

		// Store file on disk (validates file type via magic bytes).
		writtenBytes, saveErr := store.Save(fileID, file)
		if saveErr != nil {
			slog.Warn("file upload rejected", "error", saveErr)
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: fmt.Sprintf("upload rejected: %s", saveErr),
			})
			return
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

		// Insert attachment record in DB (unlinked — message_id is NULL).
		user, _ = r.Context().Value(UserKey).(*db.User)
		safeFilename := sanitizeUploadFilename(header.Filename)
		if err := database.CreateAttachment(fileID, user.ID, safeFilename, fileID, mime, writtenBytes, width, height); err != nil {
			// Clean up stored file on DB failure.
			_ = store.Delete(fileID)
			slog.Error("failed to create attachment record", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to save attachment",
			})
			return
		}

		slog.Info("file uploaded", "id", fileID, "filename", safeFilename, "size", writtenBytes, "mime", mime)

		writeJSON(w, http.StatusCreated, uploadResponse{
			ID:       fileID,
			Filename: safeFilename,
			Size:     writtenBytes,
			Mime:     mime,
			URL:      "/api/v1/files/" + fileID,
			Width:    width,
			Height:   height,
		})
	}
}

func handleServeFile(database *db.DB, store *storage.Storage, allowedOrigins []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fileID := chi.URLParam(r, "id")
		if fileID == "" {
			http.NotFound(w, r)
			return
		}

		user, _ := r.Context().Value(UserKey).(*db.User)
		role, _ := r.Context().Value(RoleKey).(*db.Role)

		// Look up attachment metadata with channel context.
		aa, err := database.GetAttachmentWithChannel(fileID)
		if err != nil {
			slog.Error("failed to look up attachment", "id", fileID, "error", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "internal server error",
			})
			return
		}
		if aa == nil {
			http.NotFound(w, r)
			return
		}

		// ── Access control ──────────────────────────────────────────────
		isAdmin := role != nil && permissions.HasAdmin(role.Permissions)

		if !isAdmin {
			if aa.ChannelID == nil {
				// Unlinked attachment — only the uploader may access.
				// Legacy rows (NULL uploader_id) are allowed through with a warning.
				if aa.UploaderID == nil {
					slog.Warn("legacy attachment served without uploader_id", "id", fileID)
				} else if user == nil || *aa.UploaderID != user.ID {
					writeJSON(w, http.StatusForbidden, errorResponse{
						Error:   "FORBIDDEN",
						Message: "you do not have access to this file",
					})
					return
				}
			} else {
				// Linked attachment — check channel permissions.
				if aa.ChannelType == "dm" {
					if user == nil {
						writeJSON(w, http.StatusForbidden, errorResponse{
							Error:   "FORBIDDEN",
							Message: "you do not have access to this file",
						})
						return
					}
					ok, dmErr := database.IsDMParticipant(user.ID, *aa.ChannelID)
					if dmErr != nil || !ok {
						writeJSON(w, http.StatusForbidden, errorResponse{
							Error:   "FORBIDDEN",
							Message: "you do not have access to this file",
						})
						return
					}
				} else if !hasChannelPermREST(database, role, *aa.ChannelID, permissions.ReadMessages) {
					writeJSON(w, http.StatusForbidden, errorResponse{
						Error:   "FORBIDDEN",
						Message: "you do not have access to this file",
					})
					return
				}
			}
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
		w.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d, immutable", fileCacheMaxAgeSeconds))
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
