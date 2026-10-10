// gif_favorites_handler.go — per-user saved GIFs (migration 059).
//
// Stores provider URLs and a title only, never bytes. URLs must pass the same
// rule the client picker applies to provider results: https on klipy.com or a
// subdomain, no embedded credentials.

package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
)

const (
	gifFavMaxURLLen   = 2048
	gifFavMaxTitleLen = 200
	gifFavMaxBody     = 8192
)

type gifFavoriteJSON struct {
	URL        string `json:"url"`
	PreviewURL string `json:"preview_url"`
	Title      string `json:"title"`
}

// allowedGIFFavoriteURL reports whether raw is an https Klipy CDN URL.
func allowedGIFFavoriteURL(raw string) bool {
	if raw == "" || len(raw) > gifFavMaxURLLen {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil {
		return false
	}
	h := u.Hostname()
	return h == "klipy.com" || strings.HasSuffix(h, ".klipy.com")
}

func handleListGIFFavorites(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		favs, err := database.ListGIFFavorites(r.Context(), user.ID)
		if err != nil {
			slog.Error("list gif favorites", "error", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load favorites")
			return
		}
		out := make([]gifFavoriteJSON, len(favs))
		for i, f := range favs {
			out[i] = gifFavoriteJSON{URL: f.URL, PreviewURL: f.PreviewURL, Title: f.Title}
		}
		writeJSON(w, http.StatusOK, map[string]any{"favorites": out})
	}
}

func handleAddGIFFavorite(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, gifFavMaxBody)
		var in gifFavoriteJSON
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeErr(w, http.StatusBadRequest, "INVALID_INPUT", "invalid request body")
			return
		}
		if in.PreviewURL == "" {
			in.PreviewURL = in.URL
		}
		if !allowedGIFFavoriteURL(in.URL) || !allowedGIFFavoriteURL(in.PreviewURL) {
			writeErr(w, http.StatusBadRequest, "INVALID_INPUT", "url must be an https GIF URL from the GIF provider")
			return
		}
		if len(in.Title) > gifFavMaxTitleLen {
			writeErr(w, http.StatusBadRequest, "INVALID_INPUT", "title is too long")
			return
		}
		err := database.AddGIFFavorite(r.Context(), user.ID, db.GIFFavorite{URL: in.URL, PreviewURL: in.PreviewURL, Title: in.Title})
		if errors.Is(err, db.ErrGIFFavoritesFull) {
			writeErr(w, http.StatusConflict, "GIF_FAVORITES_FULL", "you have reached the favorite GIF limit")
			return
		}
		if err != nil {
			slog.Error("add gif favorite", "error", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not save favorite")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleRemoveGIFFavorite(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		if err := database.RemoveGIFFavorite(r.Context(), user.ID, r.URL.Query().Get("url")); err != nil {
			slog.Error("remove gif favorite", "error", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not remove favorite")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
