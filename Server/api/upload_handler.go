package api

import (
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/owncord/server/db"
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

// MountUploadRoutes registers upload and file-serving endpoints.
// allowedOrigins controls the Access-Control-Allow-Origin header on served files.
func MountUploadRoutes(r chi.Router, database *db.DB, store *storage.Storage, allowedOrigins []string) {
	// Upload requires authentication and a higher body size limit (100 MB).
	r.With(
		AuthMiddleware(database),
		MaxBodySize(100<<20),
	).Post("/api/v1/uploads", handleUpload(database, store))
	// File serving is public (URLs are unguessable UUIDs).
	r.Get("/api/v1/files/{id}", handleServeFile(database, store, allowedOrigins))
}

func handleUpload(database *db.DB, store *storage.Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Parse multipart form — 10 MB in memory, rest on disk.
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":   "BAD_REQUEST",
				"message": "invalid multipart form",
			})
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":   "BAD_REQUEST",
				"message": "missing file field",
			})
			return
		}
		defer file.Close() //nolint:errcheck

		// Generate UUID for storage.
		fileID := uuid.New().String()

		// Detect MIME type from actual file bytes (never trust client header).
		var sniffBuf [512]byte
		n, readErr := file.Read(sniffBuf[:])
		if readErr != nil && readErr.Error() != "EOF" && readErr.Error() != "unexpected EOF" {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":   "BAD_REQUEST",
				"message": "failed to read uploaded file",
			})
			return
		}
		detectedMime := http.DetectContentType(sniffBuf[:n])
		// Seek back so the full content is available for storage.
		if _, seekErr := file.Seek(0, 0); seekErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error":   "INTERNAL_ERROR",
				"message": "failed to process uploaded file",
			})
			return
		}
		mime := detectedMime

		// Store file on disk (validates file type via magic bytes).
		if err := store.Save(fileID, file); err != nil {
			slog.Warn("file upload rejected", "error", err)
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":   "BAD_REQUEST",
				"message": fmt.Sprintf("upload rejected: %s", err),
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
		if err := database.CreateAttachment(fileID, header.Filename, fileID, mime, header.Size, width, height); err != nil {
			// Clean up stored file on DB failure.
			_ = store.Delete(fileID)
			slog.Error("failed to create attachment record", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error":   "INTERNAL_ERROR",
				"message": "failed to save attachment",
			})
			return
		}

		slog.Info("file uploaded", "id", fileID, "filename", header.Filename, "size", header.Size, "mime", mime)

		writeJSON(w, http.StatusCreated, uploadResponse{
			ID:       fileID,
			Filename: header.Filename,
			Size:     header.Size,
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

		// Look up attachment metadata.
		att, err := database.GetAttachmentByID(fileID)
		if err != nil {
			slog.Error("failed to look up attachment", "id", fileID, "error", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "internal server error",
			})
			return
		}
		if att == nil {
			http.NotFound(w, r)
			return
		}

		// Open file from storage.
		f, err := store.Open(att.StoredAs)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close() //nolint:errcheck

		// Set headers before ServeContent to ensure correct MIME type.
		w.Header().Set("Content-Type", att.MimeType)
		w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": att.Filename}))
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
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

		// Use the actual file modification time so If-Modified-Since works correctly.
		var modTime time.Time
		if info, statErr := f.Stat(); statErr == nil {
			modTime = info.ModTime()
		}
		http.ServeContent(w, r, att.Filename, modTime, f)
	}
}
