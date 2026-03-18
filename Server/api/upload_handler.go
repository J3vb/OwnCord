package api

import (
	"fmt"
	"log/slog"
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
}

// MountUploadRoutes registers upload and file-serving endpoints.
func MountUploadRoutes(r chi.Router, database *db.DB, store *storage.Storage) {
	// Upload requires authentication and a higher body size limit (100 MB).
	r.With(
		AuthMiddleware(database),
		MaxBodySize(100<<20),
	).Post("/api/v1/uploads", handleUpload(database, store))
	// File serving is public (URLs are unguessable UUIDs).
	r.Get("/api/v1/files/{id}", handleServeFile(database, store))
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

		// Detect MIME type from the Content-Type header (set by the browser).
		mime := header.Header.Get("Content-Type")
		if mime == "" {
			mime = "application/octet-stream"
		}
		// Strip parameters (e.g., "image/png; charset=utf-8" → "image/png").
		if idx := strings.Index(mime, ";"); idx != -1 {
			mime = strings.TrimSpace(mime[:idx])
		}

		// Store file on disk (validates file type via magic bytes).
		if err := store.Save(fileID, file); err != nil {
			slog.Warn("file upload rejected", "error", err)
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":   "BAD_REQUEST",
				"message": fmt.Sprintf("upload rejected: %s", err),
			})
			return
		}

		// Insert attachment record in DB (unlinked — message_id is NULL).
		if err := database.CreateAttachment(fileID, header.Filename, fileID, mime, header.Size); err != nil {
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
		})
	}
}

func handleServeFile(database *db.DB, store *storage.Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fileID := chi.URLParam(r, "id")
		if fileID == "" {
			http.NotFound(w, r)
			return
		}

		// Look up attachment metadata.
		att, err := database.GetAttachmentByID(fileID)
		if err != nil {
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
		w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, att.Filename))
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		// CORS: allow webview to read the response body.
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Type, Content-Length")

		modTime := time.Now()
		http.ServeContent(w, r, att.Filename, modTime, f)
	}
}
