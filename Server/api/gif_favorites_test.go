package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

func buildGIFFavoritesRouter(database *db.DB) http.Handler {
	r := chi.NewRouter()
	api.MountGIFRoutes(r, service.NewSessionService(database), auth.NewRateLimiter(), &config.Config{}, database)
	return r
}

func gifFavDo(t *testing.T, router http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func gifFavList(t *testing.T, router http.Handler, token string) []map[string]string {
	t.Helper()
	rr := gifFavDo(t, router, http.MethodGet, "/api/v1/gif/favorites", token, "")
	if rr.Code != http.StatusOK {
		t.Fatalf("list status = %d (%s)", rr.Code, rr.Body.String())
	}
	var body struct {
		Favorites []map[string]string `json:"favorites"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return body.Favorites
}

func TestGIFFavorites_RequireAuth(t *testing.T) {
	router := buildGIFFavoritesRouter(newMigratedAuthTestDB(t))
	for _, m := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		if rr := gifFavDo(t, router, m, "/api/v1/gif/favorites", "", ""); rr.Code != http.StatusUnauthorized {
			t.Errorf("%s without token = %d, want 401", m, rr.Code)
		}
	}
}

func TestGIFFavorites_AddListRemove(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	token := profileCreateToken(t, database, "favuser", 4)
	router := buildGIFFavoritesRouter(database)

	for _, n := range []string{"a", "b"} {
		body := fmt.Sprintf(`{"url":"https://media.klipy.com/%s.gif","preview_url":"https://media.klipy.com/%s_t.gif","title":"%s"}`, n, n, n)
		if rr := gifFavDo(t, router, http.MethodPut, "/api/v1/gif/favorites", token, body); rr.Code != http.StatusNoContent {
			t.Fatalf("add %s = %d (%s)", n, rr.Code, rr.Body.String())
		}
	}
	got := gifFavList(t, router, token)
	if len(got) != 2 || got[0]["title"] != "b" || got[0]["preview_url"] != "https://media.klipy.com/b_t.gif" {
		t.Fatalf("list = %+v, want b then a", got)
	}

	rr := gifFavDo(t, router, http.MethodDelete, "/api/v1/gif/favorites?url=https%3A%2F%2Fmedia.klipy.com%2Fb.gif", token, "")
	if rr.Code != http.StatusNoContent {
		t.Fatalf("remove = %d", rr.Code)
	}
	if got := gifFavList(t, router, token); len(got) != 1 || got[0]["title"] != "a" {
		t.Fatalf("after remove = %+v", got)
	}
}

func TestGIFFavorites_PreviewDefaultsToURL(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	token := profileCreateToken(t, database, "favuser", 4)
	router := buildGIFFavoritesRouter(database)
	gifFavDo(t, router, http.MethodPut, "/api/v1/gif/favorites", token, `{"url":"https://media.klipy.com/a.gif"}`)
	got := gifFavList(t, router, token)
	if len(got) != 1 || got[0]["preview_url"] != "https://media.klipy.com/a.gif" {
		t.Fatalf("list = %+v", got)
	}
}

func TestGIFFavorites_RejectsDisallowedURLs(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	token := profileCreateToken(t, database, "favuser", 4)
	router := buildGIFFavoritesRouter(database)
	for _, u := range []string{
		"http://media.klipy.com/a.gif",
		"https://evil.example/a.gif",
		"https://notklipy.com/a.gif",
		"https://klipy.com.evil.example/a.gif",
		"https://user:pw@media.klipy.com/a.gif",
		"javascript:alert(1)",
		"",
	} {
		body := fmt.Sprintf(`{"url":%q}`, u)
		if rr := gifFavDo(t, router, http.MethodPut, "/api/v1/gif/favorites", token, body); rr.Code != http.StatusBadRequest {
			t.Errorf("url %q = %d, want 400", u, rr.Code)
		}
	}
	bad := `{"url":"https://media.klipy.com/a.gif","preview_url":"https://evil.example/t.gif"}`
	if rr := gifFavDo(t, router, http.MethodPut, "/api/v1/gif/favorites", token, bad); rr.Code != http.StatusBadRequest {
		t.Errorf("bad preview = %d, want 400", rr.Code)
	}
	if got := gifFavList(t, router, token); len(got) != 0 {
		t.Errorf("rejected URLs were stored: %+v", got)
	}
}

func TestGIFFavorites_CapReturnsConflict(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	token := profileCreateToken(t, database, "favuser", 4)
	router := buildGIFFavoritesRouter(database)
	for i := 0; i < db.MaxGIFFavorites; i++ {
		body := fmt.Sprintf(`{"url":"https://media.klipy.com/%d.gif"}`, i)
		if rr := gifFavDo(t, router, http.MethodPut, "/api/v1/gif/favorites", token, body); rr.Code != http.StatusNoContent {
			t.Fatalf("add %d = %d", i, rr.Code)
		}
	}
	rr := gifFavDo(t, router, http.MethodPut, "/api/v1/gif/favorites", token, `{"url":"https://media.klipy.com/over.gif"}`)
	if rr.Code != http.StatusConflict || !strings.Contains(rr.Body.String(), "GIF_FAVORITES_FULL") {
		t.Fatalf("over cap = %d %s, want 409 GIF_FAVORITES_FULL", rr.Code, rr.Body.String())
	}
}

func TestGIFFavorites_AreIsolatedPerUser(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	alice := profileCreateToken(t, database, "alice", 4)
	bob := profileCreateToken(t, database, "bob", 4)
	router := buildGIFFavoritesRouter(database)
	gifFavDo(t, router, http.MethodPut, "/api/v1/gif/favorites", alice, `{"url":"https://media.klipy.com/a.gif"}`)
	if got := gifFavList(t, router, bob); len(got) != 0 {
		t.Fatalf("bob sees alice's favorites: %+v", got)
	}
}
