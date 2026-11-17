package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

// handleServerIcon is GET /api/v1/server-icon: the owner-uploaded PNG, public like server-info (a client
// shows it before sign-in). The ETag is the content hash server-info reports, so ?v=<hash> URLs stay valid for
// the five minutes the response may be reused; 404 when there is no icon.
func handleServerIcon(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, hash, err := svc.Settings.ServerIcon(r.Context())
		if err != nil {
			if errors.Is(err, service.ErrNoServerIcon) {
				writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "no server icon")
				return
			}
			slog.ErrorContext(r.Context(), "server icon read failed", "error", err)
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "internal server error")
			return
		}
		etag := `"` + hash + `"`
		h := w.Header()
		h.Set("Content-Type", "image/png")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Cache-Control", "public, max-age=300")
		h.Set("ETag", etag)
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		h.Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}
