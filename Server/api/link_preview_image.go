package api

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/linkpreview"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// linkPreviewImageRateLimitPerMinute caps thumbnail requests per client. A page of history can
// name a few dozen thumbnails and the response is cached for a year, so a member who opens
// many channels stays well under it.
const linkPreviewImageRateLimitPerMinute = 300

// MountLinkPreviewImageRoute serves the stored thumbnails of link preview cards at
// GET /api/v1/link-previews/images/{hash}, to any signed-in member. The hash is the SHA-256 of
// the thumbnail's bytes, so a name names its content: a member who holds a card holds the hash,
// and one who guesses a 64-character hash has the picture, which is already public content
// fetched from the open web.
func MountLinkPreviewImageRoute(r chi.Router, sessions *service.SessionService, limiter *auth.RateLimiter, trustedProxies []string, store *linkpreview.Store) {
	r.With(
		AuthMiddleware(sessions),
		RateLimitMiddleware(limiter, "link_preview_img:", linkPreviewImageRateLimitPerMinute, time.Minute, trustedProxies),
	).Get("/api/v1/link-previews/images/{hash}", handleLinkPreviewImage(store))
}

// handleLinkPreviewImage answers a stored thumbnail with its type, a year of private caching
// (a name never changes its bytes) and headers that keep the response inert. A name that is not
// a stored thumbnail is a 404; so is a stored name whose file is gone.
func handleLinkPreviewImage(store *linkpreview.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hash := chi.URLParam(r, "hash")
		if !linkpreview.ValidHash(hash) {
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "thumbnail not found")
			return
		}
		img, err := store.Image(r.Context(), hash)
		if err != nil {
			if !errors.Is(err, db.ErrNotFound) {
				slog.Warn("link preview thumbnail row unreadable", "error", err)
			}
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "thumbnail not found")
			return
		}
		f, err := store.OpenImage(hash)
		if err != nil {
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "thumbnail not found")
			return
		}
		defer f.Close() //nolint:errcheck // read-only file
		if err := store.TouchMany(r.Context(), nil, []string{hash}); err != nil {
			slog.Debug("link preview thumbnail touch failed", "error", err)
		}
		h := w.Header()
		h.Set("Content-Type", img.MimeType)
		h.Set("Cache-Control", "private, max-age=31536000, immutable")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
		h.Set("ETag", `"`+hash+`"`)
		http.ServeContent(w, r, "", time.Time{}, f)
	}
}
