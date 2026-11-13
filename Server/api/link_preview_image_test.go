package api_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/linkpreview"
)

func TestLinkPreviewImageRoute(t *testing.T) {
	var dataDir string
	router, database := fullRouterWithConfig(t, func(c *config.Config) { dataDir = c.Server.DataDir })
	token := createUserToken(t, database, "lp-img-token-", "viewer", 4)
	store, err := linkpreview.NewStore(database, filepath.Join(dataDir, linkpreview.DirName))
	if err != nil {
		t.Fatal(err)
	}
	body := []byte("not really a jpeg, but the route serves what was stored")
	hash, err := store.PutImage(t.Context(), body, "image/jpeg", 10, 10)
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/link-previews/images/" + hash

	t.Run("needs a session", func(t *testing.T) {
		rr := doAPI(t, router, http.MethodGet, path, "", nil)
		requireStatus(t, rr, http.StatusUnauthorized)
	})

	t.Run("serves the stored bytes with inert headers", func(t *testing.T) {
		if err := database.TouchLinkPreviewImage(t.Context(), hash, "2000-01-01T00:00:00Z"); err != nil {
			t.Fatal(err)
		}
		rr := doAPI(t, router, http.MethodGet, path, token, nil)
		requireStatus(t, rr, http.StatusOK)
		if rr.Body.String() != string(body) {
			t.Errorf("body = %q", rr.Body.String())
		}
		want := map[string]string{
			"Content-Type":            "image/jpeg",
			"Cache-Control":           "private, max-age=31536000, immutable",
			"X-Content-Type-Options":  "nosniff",
			"Content-Security-Policy": "default-src 'none'; sandbox",
			"ETag":                    `"` + hash + `"`,
		}
		for k, v := range want {
			if got := rr.Header().Get(k); got != v {
				t.Errorf("%s = %q, want %q", k, got, v)
			}
		}
		img, err := store.Image(t.Context(), hash)
		if err != nil || img.LastUsedAt <= "2000-01-01T00:00:00Z" {
			t.Errorf("last_used_at = %q (%v), want it touched", img.LastUsedAt, err)
		}
	})

	t.Run("answers a repeat with 304", func(t *testing.T) {
		req := newAPIRequest(http.MethodGet, path, token, nil)
		req.Header.Set("If-None-Match", `"`+hash+`"`)
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		requireStatus(t, rr, http.StatusNotModified)
	})

	t.Run("404 for an unknown or invalid hash", func(t *testing.T) {
		for _, h := range []string{
			strings.Repeat("0", 64), "short", strings.ToUpper(hash), hash[:63] + "g", "..%2F..%2Fetc%2Fpasswd",
		} {
			rr := doAPI(t, router, http.MethodGet, "/api/v1/link-previews/images/"+h, token, nil)
			if rr.Code != http.StatusNotFound {
				t.Errorf("hash %q: status %d, want 404", h, rr.Code)
			}
		}
	})

	t.Run("404 when the row outlived its file", func(t *testing.T) {
		if err := os.Remove(filepath.Join(dataDir, linkpreview.DirName, hash[:2], hash)); err != nil {
			t.Fatal(err)
		}
		rr := doAPI(t, router, http.MethodGet, path, token, nil)
		requireStatus(t, rr, http.StatusNotFound)
	})
}
