// Phase C Step 9 — PluginAdminHandler tests.
//
// The handler is covered at the HTTP boundary so the fixtures do not depend
// on the Wazero runtime. A nil Registry exercises the "plugin runtime
// disabled" branch; a real Registry wired against a real in-memory DB
// exercises the happy path.
package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/plugin"
)

// openPluginTestDB opens an in-memory database with the full migration set so
// the plugins and plugin_kv tables exist. *db.DB satisfies the plugin.Config
// Store interface directly (D3 removed the store abstraction).
func openPluginTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

func TestPluginsHandlerListEmptyWhenRegistryNil(t *testing.T) {
	h := NewPluginAdminHandler(nil, nil, nil)
	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("expected empty JSON array, got %q", rec.Body.String())
	}
}

func TestPluginsHandlerInstallRejectsWhenRegistryNil(t *testing.T) {
	h := NewPluginAdminHandler(nil, nil, nil)
	body, contentType := buildZipUpload(t, validPluginZip(t))
	req := httptest.NewRequest("POST", "/install", body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status: got %d, want 503", rec.Code)
	}
}

func TestPluginsHandlerInstallRejectsNonZipContentType(t *testing.T) {
	reg := newTestPluginRegistry(t)
	h := NewPluginAdminHandler(reg, nil, nil)

	// Build a multipart body whose file part is labelled as text/plain.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	partHeader := make(map[string][]string)
	partHeader["Content-Disposition"] = []string{`form-data; name="plugin"; filename="evil.txt"`}
	partHeader["Content-Type"] = []string{"text/plain"}
	part, err := mw.CreatePart(partHeader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(validPluginZip(t)); err != nil {
		t.Fatal(err)
	}
	_ = mw.Close()

	req := httptest.NewRequest("POST", "/install", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status: got %d, want 415; body=%s", rec.Code, rec.Body.String())
	}
}

func TestPluginsHandlerInstallRejectsNonZipMagic(t *testing.T) {
	reg := newTestPluginRegistry(t)
	h := NewPluginAdminHandler(reg, nil, nil)

	body, contentType := buildZipUpload(t, []byte("this is definitely not a zip"))
	req := httptest.NewRequest("POST", "/install", body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

func TestPluginsHandlerInstallHappyPath(t *testing.T) {
	reg := newTestPluginRegistry(t)
	mem := openPluginTestDB(t)
	// Wire the store into the handler so /list can show the new row. The
	// registry already writes via its own PluginStore.
	h := NewPluginAdminHandler(reg, mem, nil)
	body, contentType := buildZipUpload(t, validPluginZip(t))
	req := httptest.NewRequest("POST", "/install", body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status: got %d, want 201; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "hello") {
		t.Fatalf("expected plugin name in response, got %q", rec.Body.String())
	}
}

// The admin panel's empty state distinguishes "no plugins installed" from
// "the runtime is off", which it can only do from this header.
func TestPluginsHandlerListReportsRuntimeState(t *testing.T) {
	off := NewPluginAdminHandler(nil, nil, nil)
	rec := httptest.NewRecorder()
	off.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if got := rec.Header().Get("X-Plugin-Runtime"); got != "disabled" {
		t.Fatalf("nil registry: X-Plugin-Runtime = %q, want %q", got, "disabled")
	}

	on := NewPluginAdminHandler(newTestPluginRegistry(t), openPluginTestDB(t), nil)
	rec = httptest.NewRecorder()
	on.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if got := rec.Header().Get("X-Plugin-Runtime"); got != "enabled" {
		t.Fatalf("live registry: X-Plugin-Runtime = %q, want %q", got, "enabled")
	}
}

// The panel reads snake_case fields; without JSON tags these marshal as
// Go field names and every column renders empty.
func TestPluginsHandlerListUsesSnakeCaseJSON(t *testing.T) {
	reg, mem := newTestPluginRegistryWithStore(t)
	h := NewPluginAdminHandler(reg, mem, nil)

	body, contentType := buildZipUpload(t, validPluginZip(t))
	req := httptest.NewRequest("POST", "/install", body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("install: got %d, want 201; body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list: got %d, want 200", rec.Code)
	}
	var rows []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &rows); err != nil {
		t.Fatalf("list body is not JSON: %v (%s)", err, rec.Body.String())
	}
	if len(rows) != 1 {
		t.Fatalf("expected 1 plugin row, got %d", len(rows))
	}
	for _, key := range []string{"id", "name", "version", "enabled", "installed_at"} {
		if _, ok := rows[0][key]; !ok {
			t.Fatalf("missing %q in plugin row: %v", key, rows[0])
		}
	}
}

func TestPluginsHandlerEnableDisableUninstallReturn503WhenRegistryNil(t *testing.T) {
	h := NewPluginAdminHandler(nil, nil, nil)
	for _, tc := range []struct{ method, path string }{
		{"POST", "/1/enable"},
		{"POST", "/1/disable"},
		{"DELETE", "/1"},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s %s status: got %d, want 503", tc.method, tc.path, rec.Code)
		}
	}
}

func TestPluginsHandlerLifecycleInvalidID(t *testing.T) {
	reg := newTestPluginRegistry(t)
	h := NewPluginAdminHandler(reg, nil, nil)
	req := httptest.NewRequest("POST", "/not-an-int/enable", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400", rec.Code)
	}
}

func TestIsZipContentType(t *testing.T) {
	cases := map[string]bool{
		"application/zip":                 true,
		"application/zip; charset=binary": true,
		"APPLICATION/ZIP":                 true,
		"application/x-zip-compressed":    true,
		"application/octet-stream":        true,
		"text/plain":                      false,
		"image/png":                       false,
		"":                                false,
		"application/json; charset=utf-8": false,
	}
	for ct, want := range cases {
		if got := isZipContentType(ct); got != want {
			t.Errorf("isZipContentType(%q) = %v, want %v", ct, got, want)
		}
	}
}

func TestHasZipMagic(t *testing.T) {
	cases := map[string]bool{
		"PK\x03\x04rest": true,
		"PK\x05\x06":     true,
		"PK\x07\x08rest": false, // spanned-archive signature; not accepted here
		"not a zip":      false,
		"":               false,
		"PK":             false,
	}
	for body, want := range cases {
		if got := hasZipMagic([]byte(body)); got != want {
			t.Errorf("hasZipMagic(%q) = %v, want %v", body, got, want)
		}
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

func newTestPluginRegistry(t *testing.T) *plugin.Registry {
	t.Helper()
	reg, _ := newTestPluginRegistryWithStore(t)
	return reg
}

// newTestPluginRegistryWithStore returns a registry alongside the database it
// writes to, for tests that then read the rows back through the handler. The
// two must be the same store, or the list is empty no matter what installed.
func newTestPluginRegistryWithStore(t *testing.T) (*plugin.Registry, *db.DB) {
	t.Helper()
	dir := t.TempDir()
	mem := openPluginTestDB(t)
	reg, err := plugin.NewRegistry(plugin.Config{
		Directory: filepath.Join(dir, "plugins"),
		Store:     mem,
	})
	if err != nil {
		t.Fatalf("plugin.NewRegistry: %v", err)
	}
	t.Cleanup(func() { _ = reg.Close(context.Background()) })
	return reg, mem
}

// validPluginZip returns a minimal but structurally valid plugin package:
// a plugin.json manifest at the root plus a near-empty hello.wasm that is
// large enough to pass the entrypoint stat but small enough to fly well
// under the zip-bomb cap.
func validPluginZip(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	mj, err := zw.Create("plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mj.Write([]byte(`{"name":"hello","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"]}`)); err != nil {
		t.Fatal(err)
	}
	w, err := zw.Create("hello.wasm")
	if err != nil {
		t.Fatal(err)
	}
	// Minimal "placeholder" wasm magic bytes. Default build does not attempt
	// to compile the module, so any bytes with the wasm magic suffice for
	// InstallFromZip's on-disk validation.
	if _, err := w.Write([]byte("\x00asm\x01\x00\x00\x00")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// buildZipUpload wraps bodyBytes in a multipart form with a single "plugin"
// file part labelled as application/zip.
func buildZipUpload(t *testing.T, bodyBytes []byte) (io.Reader, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	partHeader := make(map[string][]string)
	partHeader["Content-Disposition"] = []string{`form-data; name="plugin"; filename="hello.zip"`}
	partHeader["Content-Type"] = []string{"application/zip"}
	part, err := mw.CreatePart(partHeader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(bodyBytes); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, mw.FormDataContentType()
}
