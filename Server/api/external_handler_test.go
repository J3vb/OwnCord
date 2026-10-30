package api_test

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strconv"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/externalcontent"
	"github.com/J3vb/OwnCord/Server/safefetch"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

var externalGIF = []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;")

// externalRouter mounts the broker routes over a broker that may reach srv,
// a loopback stub; everything else about its policies is production.
func externalRouter(t *testing.T, database *db.DB, srv *httptest.Server) http.Handler {
	t.Helper()
	_, portText, err := net.SplitHostPort(srv.Listener.Addr().String())
	if err != nil {
		t.Fatalf("SplitHostPort: %v", err)
	}
	port, _ := strconv.Atoi(portText)
	tweak := func(p safefetch.Policy) safefetch.Policy {
		p.Schemes = []string{"http"}
		p.Ports = []int{port}
		p.Classify = func(addr netip.Addr) error {
			if addr.Unmap().IsLoopback() {
				return nil
			}
			return safefetch.ClassifyAddr(addr)
		}
		return p
	}
	broker, err := externalcontent.New(tweak(externalcontent.DefaultPagePolicy), tweak(externalcontent.DefaultImagePolicy))
	if err != nil {
		t.Fatalf("externalcontent.New: %v", err)
	}
	r := chi.NewRouter()
	api.MountExternalContentRoutes(r, service.NewSessionService(database), auth.NewRateLimiter(), &config.Config{}, broker)
	return r
}

func externalGET(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func externalStub(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte(`<html><head><meta property="og:title" content="Hello"><meta property="og:image" content="/a.gif"></head></html>`))
		case "/a.gif":
			w.Header().Set("Content-Type", "image/gif")
			_, _ = w.Write(externalGIF)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestExternalContent_RequiresASession(t *testing.T) {
	srv := externalStub(t)
	router := externalRouter(t, newAuthTestDB(t), srv)
	for _, p := range []string{"/api/v1/external/preview?url=x", "/api/v1/external/image?url=x"} {
		if rr := externalGET(t, router, p, ""); rr.Code != http.StatusUnauthorized {
			t.Errorf("%s without a token = %d, want 401", p, rr.Code)
		}
	}
}

func TestExternalContent_PreviewThenImageByHandle(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "viewer", 4)
	srv := externalStub(t)
	router := externalRouter(t, database, srv)

	rr := externalGET(t, router, "/api/v1/external/preview?url="+url.QueryEscape(srv.URL+"/page"), token)
	if rr.Code != http.StatusOK {
		t.Fatalf("preview status = %d (%s)", rr.Code, rr.Body.String())
	}
	if cc := rr.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("preview Cache-Control = %q, want no-store", cc)
	}
	var preview struct {
		OK    bool `json:"ok"`
		Value struct {
			Title *string `json:"title"`
			Image *string `json:"image"`
		} `json:"value"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &preview); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !preview.OK || preview.Value.Title == nil || *preview.Value.Title != "Hello" || preview.Value.Image == nil {
		t.Fatalf("preview = %s", rr.Body.String())
	}

	rr = externalGET(t, router, "/api/v1/external/image?handle="+url.QueryEscape(*preview.Value.Image), token)
	if rr.Code != http.StatusOK || rr.Header().Get("Content-Type") != "image/gif" || rr.Body.String() != string(externalGIF) {
		t.Fatalf("image = %d %q %q", rr.Code, rr.Header().Get("Content-Type"), rr.Body.String())
	}
	for k, want := range map[string]string{
		"X-Content-Type-Options":  "nosniff",
		"Content-Security-Policy": "default-src 'none'; sandbox",
		"Cache-Control":           "private, max-age=3600",
	} {
		if got := rr.Header().Get(k); got != want {
			t.Errorf("image %s = %q, want %q", k, got, want)
		}
	}
}

func TestExternalContent_RefusalsAreTypedAnswers(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "viewer", 4)
	srv := externalStub(t)
	router := externalRouter(t, database, srv)
	cases := map[string]externalcontent.Failure{
		"/api/v1/external/preview": externalcontent.BlockedDestination,
		"/api/v1/external/preview?url=" + url.QueryEscape("http://10.0.0.1/"):      externalcontent.BlockedDestination,
		"/api/v1/external/preview?url=" + url.QueryEscape(srv.URL+"/missing"):      externalcontent.Unavailable,
		"/api/v1/external/image?url=" + url.QueryEscape(srv.URL+"/page"):           externalcontent.WrongType,
		"/api/v1/external/image?handle=not-a-handle":                               externalcontent.ExpiredHandle,
		"/api/v1/external/image?handle=x&url=" + url.QueryEscape(srv.URL+"/a.gif"): externalcontent.BlockedDestination,
	}
	for path, want := range cases {
		rr := externalGET(t, router, path, token)
		var body struct {
			OK      bool   `json:"ok"`
			Failure string `json:"failure"`
		}
		if rr.Code != http.StatusOK || json.Unmarshal(rr.Body.Bytes(), &body) != nil || body.OK || body.Failure != string(want) {
			t.Errorf("%s = %d %s, want a %s refusal", path, rr.Code, rr.Body.String(), want)
		}
		if cc := rr.Header().Get("Cache-Control"); cc != "no-store" {
			t.Errorf("%s Cache-Control = %q, want no-store", path, cc)
		}
	}
}

// With the shipped configuration the broker is not mounted at all; it comes
// with the browser client.
func TestExternalContent_MountedOnlyWithTheBrowserClient(t *testing.T) {
	has := func(h http.Handler) bool {
		found := false
		routes, _ := h.(chi.Routes)
		_ = chi.Walk(routes, func(_, pattern string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
			if pattern == "/api/v1/external/preview" || pattern == "/api/v1/external/image" {
				found = true
			}
			return nil
		})
		return found
	}
	if has(fullRouter(t)) {
		t.Fatal("the default router mounts the external-content broker")
	}
	if !has(enabledBrowserHostingRouter(t, nil)) {
		t.Fatal("the router with the browser client on does not mount the broker")
	}
}
