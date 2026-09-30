package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/app"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// The upload route refuses a file by its name under the owner's file-type
// policy, with the existing blocked-file-type refusal, before any byte lands.

func fileTypeHarness(t *testing.T, policy storage.FileTypePolicy) *quotaHarness {
	t.Helper()
	h := newQuotaHarness(t, nil)
	h.uploads.SetStorageLimits(service.StorageLimits{Dir: h.dir, MaxUploadBytes: 10 << 20, FileTypes: policy})
	return h
}

func assertBlocked(t *testing.T, h *quotaHarness, filename string, content []byte, detail string) {
	t.Helper()
	rr := doUpload(t, h.router, h.token, "file", filename, content)
	assertErrorCode(t, rr, http.StatusBadRequest, "BAD_REQUEST")
	if want := "upload rejected: blocked file type: " + detail; !strings.Contains(rr.Body.String(), want) {
		t.Fatalf("upload %q: body = %s, want %q", filename, rr.Body.String(), want)
	}
	if n := h.filesOnDisk(t); n != 0 {
		t.Fatalf("upload %q: %d file(s) on disk after a refusal", filename, n)
	}
}

func TestUpload_BlockedExtensionRefused(t *testing.T) {
	h := fileTypeHarness(t, storage.FileTypePolicy{Blocked: storage.DefaultBlockedExtensions})
	assertBlocked(t, h, "cleanup.BAT", []byte("@echo off\r\n"), ".bat")
	assertBlocked(t, h, "report.pdf.ps1", []byte("Get-ChildItem\n"), ".ps1")
	assertBlocked(t, h, "photo.jpg.hta", []byte("<html></html>"), ".hta")

	for _, name := range []string{"notes.txt", "www.amazon.com.txt", "notes.hta.txt"} {
		if rr := doUpload(t, h.router, h.token, "file", name, []byte("hello")); rr.Code != http.StatusCreated {
			t.Fatalf("%s: status %d, body %s", name, rr.Code, rr.Body.String())
		}
	}
}

func TestUpload_AllowOnlyMode(t *testing.T) {
	h := fileTypeHarness(t, storage.FileTypePolicy{Allowed: []string{"txt", "exe"}})
	assertBlocked(t, h, "photo.png", []byte("not really a png"), ".png")
	assertBlocked(t, h, "README", []byte("hello"), "no file extension")
	if rr := doUpload(t, h.router, h.token, "file", "notes.TXT", []byte("hello")); rr.Code != http.StatusCreated {
		t.Fatalf("notes.TXT: status %d, body %s", rr.Code, rr.Body.String())
	}
}

// An owner who allows an extension never unlocks the content blocks: a PE
// executable is refused whatever it is called.
func TestUpload_MagicBlocksApplyToAnAllowedExtension(t *testing.T) {
	h := fileTypeHarness(t, storage.FileTypePolicy{Allowed: []string{"exe", "txt"}})
	assertBlocked(t, h, "tool.exe", []byte("MZ\x90\x00\x03\x00\x00\x00"), "PE executable")
	assertBlocked(t, h, "notes.txt", []byte("#!/bin/sh\necho hi\n"), "shell script")
}

func TestUpload_SavedPolicyReplacesConfig(t *testing.T) {
	h := fileTypeHarness(t, storage.FileTypePolicy{Blocked: storage.DefaultBlockedExtensions})
	if _, err := service.NewSettingsService(h.database).Patch(context.Background(), h.userID, map[string]string{
		service.UploadBlockedExtensionsKey: "txt",
	}); err != nil {
		t.Fatalf("Patch: %v", err)
	}
	assertBlocked(t, h, "notes.txt", []byte("hello"), ".txt")
	if rr := doUpload(t, h.router, h.token, "file", "build.bat", []byte("@echo off\r\n")); rr.Code != http.StatusCreated {
		t.Fatalf("build.bat after the owner unblocked it: status %d, body %s", rr.Code, rr.Body.String())
	}
}

// The first auth_ok after start-up carries config.yaml's lists: the hub fills
// its settings cache while StartRuntime builds it, before NewRouter runs.
func TestNewRouter_FirstAuthOKCarriesConfigFileTypes(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	cfg := &config.Config{
		Server: config.ServerConfig{Name: "Test Server", Port: 8443, DataDir: t.TempDir(), AllowedOrigins: []string{"*"}},
		Upload: config.UploadConfig{MaxSizeMB: 10, StorageDir: t.TempDir(), BlockedExtensions: []string{"bat", "ps1"}, AllowedExtensions: []string{"txt"}},
	}
	rt, err := app.StartRuntime(cfg, database, nil)
	if err != nil {
		t.Fatalf("app.StartRuntime: %v", err)
	}
	handler, cleanup := api.NewRouter(cfg, database, "test", nil, nil, rt)
	t.Cleanup(cleanup)
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	hash, _ := auth.HashPassword("correctPass1")
	uid, err := database.CreateUser(context.Background(), "filetypes", hash, 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/ws", nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	raw, _ := json.Marshal(map[string]any{"type": "auth", "payload": map[string]any{"token": token}})
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	var authOK struct {
		Type    string `json:"type"`
		Payload struct {
			UploadPolicy struct {
				BlockedExtensions []string `json:"blocked_extensions"`
				AllowedExtensions []string `json:"allowed_extensions"`
			} `json:"upload_policy"`
		} `json:"payload"`
	}
	_, msg, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read auth_ok: %v", err)
	}
	if err := json.Unmarshal(msg, &authOK); err != nil || authOK.Type != "auth_ok" {
		t.Fatalf("auth_ok: %v; raw=%s", err, msg)
	}
	if got := authOK.Payload.UploadPolicy; !slices.Equal(got.BlockedExtensions, []string{"bat", "ps1"}) || !slices.Equal(got.AllowedExtensions, []string{"txt"}) {
		t.Fatalf("auth_ok upload_policy = %+v, want config.yaml's lists; raw=%s", got, msg)
	}
}
