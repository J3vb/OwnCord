package api_test

import (
	"bytes"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

func testIconPNG(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 64, 64))); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return buf.Bytes()
}

func TestServerIcon_AbsentIs404AndEmptyHash(t *testing.T) {
	router := setupRouterWithServices(t, func(svc *service.Services, _ *db.DB) {
		svc.Settings.SetServerIconDir(t.TempDir())
	})
	rec := serveRequest(router, httptest.NewRequest(http.MethodGet, "/api/v1/server-icon", nil))
	requireStatus(t, rec, http.StatusNotFound)
	if got, ok := serverInfoBody(t, router)["icon"]; !ok || got != "" {
		t.Errorf("server-info icon = %v (present %v), want an empty string", got, ok)
	}
}

func TestServerIcon_ServedWithHeadersAndHash(t *testing.T) {
	data := testIconPNG(t)
	router := setupRouterWithServices(t, func(svc *service.Services, _ *db.DB) {
		svc.Settings.SetServerIconDir(t.TempDir())
		if _, err := svc.Settings.SetServerIcon(t.Context(), 1, data); err != nil {
			t.Fatalf("SetServerIcon: %v", err)
		}
	})
	hash := service.ServerIconHashOf(data)

	rec := serveRequest(router, httptest.NewRequest(http.MethodGet, "/api/v1/server-icon", nil))
	requireStatus(t, rec, http.StatusOK)
	want := map[string]string{
		"Content-Type":           "image/png",
		"X-Content-Type-Options": "nosniff",
		"Cache-Control":          "public, max-age=300",
		"Etag":                   `"` + hash + `"`,
	}
	for name, v := range want {
		if got := rec.Header().Get(name); got != v {
			t.Errorf("%s = %q, want %q", name, got, v)
		}
	}
	if !bytes.Equal(rec.Body.Bytes(), data) {
		t.Error("body differs from the stored icon")
	}
	if got := serverInfoBody(t, router)["icon"]; got != hash {
		t.Errorf("server-info icon = %v, want %q", got, hash)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/server-icon", nil)
	req.Header.Set("If-None-Match", `"`+hash+`"`)
	requireStatus(t, serveRequest(router, req), http.StatusNotModified)
}
