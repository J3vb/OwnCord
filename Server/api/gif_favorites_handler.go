// gif_favorites_handler.go — per-user saved GIFs (migration 059).
//
// Stores provider URLs and a title only, never bytes. URLs must pass the same
// rule the client picker applies to provider results: https on klipy.com or a
// subdomain, no embedded credentials.

package api

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
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

func handleListGIFFavorites(favorites *service.GIFFavoriteService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		favs, err := favorites.List(r.Context(), user.ID)
		if err != nil {
			slog.Error("list gif favorites", "error", err)
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "could not load favorites")
			return
		}
		out := make([]gifFavoriteJSON, len(favs))
		for i, f := range favs {
			out[i] = gifFavoriteJSON{URL: f.URL, PreviewURL: f.PreviewURL, Title: f.Title}
		}
		writeJSON(w, http.StatusOK, map[string]any{"favorites": out})
	}
}

func handleAddGIFFavorite(favorites *service.GIFFavoriteService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, gifFavMaxBody)
		var in gifFavoriteJSON
		if !decodeJSON(w, r, &in) {
			return
		}
		if !allowedGIFFavoriteURL(in.URL) || !allowedGIFFavoriteURL(in.PreviewURL) {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "url must be an https GIF URL from the GIF provider")
			return
		}
		if len(in.Title) > gifFavMaxTitleLen {
			cut := gifFavMaxTitleLen
			for cut > 0 && !utf8.RuneStart(in.Title[cut]) {
				cut--
			}
			in.Title = in.Title[:cut]
		}
		err := favorites.Add(r.Context(), user.ID, service.GIFFavorite{URL: in.URL, PreviewURL: in.PreviewURL, Title: in.Title})
		if errors.Is(err, service.ErrGIFFavoritesFull) {
			writeErr(w, http.StatusConflict, httperr.CodeGIFFavoritesFull, "you have reached the favorite GIF limit")
			return
		}
		if err != nil {
			slog.Error("add gif favorite", "error", err)
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "could not save favorite")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleRemoveGIFFavorite(favorites *service.GIFFavoriteService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		if err := favorites.Remove(r.Context(), user.ID, r.URL.Query().Get("url")); err != nil {
			slog.Error("remove gif favorite", "error", err)
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "could not remove favorite")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
