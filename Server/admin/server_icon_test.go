package admin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/service"
)

func iconUpload(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 90, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return buf.Bytes()
}

func putIcon(t *testing.T, handler http.Handler, method, token string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/server-icon", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "image/png")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestServerIcon_PutAndDelete(t *testing.T) {
	database := openAdminTestDB(t)
	svc := newTestServices(database)
	dir := t.TempDir()
	svc.Settings.SetServerIconDir(dir)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)
	token := createAdminUser(t, database)
	data := iconUpload(t, 128, 128)

	rec := putIcon(t, handler, http.MethodPut, token, data)
	expectStatus(t, rec, http.StatusOK)
	var reply struct {
		Icon string `json:"icon"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &reply); err != nil || reply.Icon != service.ServerIconHashOf(data) {
		t.Fatalf("reply = %s (%v), want the icon hash", rec.Body.String(), err)
	}
	if got, err := database.GetSetting(context.Background(), "server_icon"); err != nil || got != reply.Icon {
		t.Fatalf("server_icon row = %q (%v), want %q", got, err, reply.Icon)
	}
	if _, err := os.Stat(filepath.Join(dir, service.ServerIconFile)); err != nil {
		t.Fatalf("icon file missing: %v", err)
	}

	expectStatus(t, putIcon(t, handler, http.MethodDelete, token, nil), http.StatusOK)
	if got, _ := database.GetSetting(context.Background(), "server_icon"); got != "" {
		t.Fatalf("server_icon row = %q after delete, want empty", got)
	}
	if _, err := os.Stat(filepath.Join(dir, service.ServerIconFile)); !os.IsNotExist(err) {
		t.Fatalf("icon file still present: %v", err)
	}
}

func TestServerIcon_PutRefusesBadUploads(t *testing.T) {
	database := openAdminTestDB(t)
	svc := newTestServices(database)
	svc.Settings.SetServerIconDir(t.TempDir())
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)
	token := createAdminUser(t, database)
	oversize := append(iconUpload(t, 64, 64), bytes.Repeat([]byte{0}, service.ServerIconMaxBytes)...)
	cases := map[string][]byte{
		"not a png":  []byte("definitely not an image"),
		"too big":    oversize,
		"not square": iconUpload(t, 64, 48),
		"too small":  iconUpload(t, 31, 31),
		"too large":  iconUpload(t, 257, 257),
		"empty":      nil,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			expectStatus(t, putIcon(t, handler, http.MethodPut, token, body), http.StatusBadRequest)
		})
	}
}

func TestServerIcon_RequiresManageServer(t *testing.T) {
	database := openAdminTestDB(t)
	svc := newTestServices(database)
	svc.Settings.SetServerIconDir(t.TempDir())
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)
	token := createMemberUser(t, database)
	expectStatus(t, putIcon(t, handler, http.MethodPut, token, iconUpload(t, 64, 64)), http.StatusForbidden)
	expectStatus(t, putIcon(t, handler, http.MethodDelete, token, nil), http.StatusForbidden)
}

func TestPatchSettings_RefusesServerIcon(t *testing.T) {
	code, msg, body, database := patchSetting(t, "server_icon", "abcdef0123456789")
	if code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", code, body)
	}
	if want := "server_icon is set with the server icon upload, not here"; msg != want {
		t.Errorf("message = %q, want %q", msg, want)
	}
	if got := storedSetting(t, database, "server_icon"); got == "abcdef0123456789" {
		t.Error("server_icon was stored despite the 400")
	}
}
