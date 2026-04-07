// Pass 4 — asset handler tests.
//
// Locks in the Pass 2 + Pass 3 hardening: only manifest-declared files are
// served, path traversal is rejected, prefix-without-separator escapes are
// rejected via the filepath.Rel check.
package plugin

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func newAssetTestInstance(t *testing.T, declaredAssets []string) (*Registry, *Instance, string) {
	t.Helper()
	dir := t.TempDir()
	// The handler uses filepath.Dir(inst.WASMPath) as pluginDir.
	wasmPath := filepath.Join(dir, "main.wasm")
	if err := os.WriteFile(wasmPath, []byte("\x00asm"), 0o644); err != nil {
		t.Fatal(err)
	}
	tabs := make([]UITab, len(declaredAssets))
	for i, a := range declaredAssets {
		tabs[i] = UITab{ID: "tab", Asset: a}
		// Create the file under the plugin dir so ServeFile can find it.
		full := filepath.Join(dir, a)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("hello: "+a), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	r := &Registry{}
	inst := &Instance{
		ID:       1,
		WASMPath: wasmPath,
		Manifest: &Manifest{
			Name:        "ui-test",
			Version:     "0.1.0",
			Entrypoint:  "main.wasm",
			Permissions: []string{string(CapUI)},
			UI:          UISpec{Tabs: tabs},
		},
	}
	return r, inst, dir
}

func TestAssetHandlerServesAllowedFile(t *testing.T) {
	r, inst, _ := newAssetTestInstance(t, []string{"index.html"})
	h := r.AssetHandler(inst)

	req := httptest.NewRequest("GET", "/index.html", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if got := w.Body.String(); got != "hello: index.html" {
		t.Fatalf("unexpected body: %q", got)
	}
}

func TestAssetHandlerRejectsUnlistedFile(t *testing.T) {
	r, inst, dir := newAssetTestInstance(t, []string{"index.html"})
	// File EXISTS in the plugin dir but is not declared in the manifest.
	if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := r.AssetHandler(inst)

	req := httptest.NewRequest("GET", "/secret.txt", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for undeclared file, got %d", w.Code)
	}
}

func TestAssetHandlerRejectsTraversal(t *testing.T) {
	r, inst, _ := newAssetTestInstance(t, []string{"index.html"})
	h := r.AssetHandler(inst)

	cases := []string{
		"/../../../etc/passwd",
		"/..%2Fpasswd",
		"/etc/passwd",
	}
	for _, p := range cases {
		req := httptest.NewRequest("GET", p, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code == http.StatusOK {
			t.Errorf("traversal path %q should not have returned 200", p)
		}
	}
}

func TestAssetHandlerServesNestedAsset(t *testing.T) {
	r, inst, _ := newAssetTestInstance(t, []string{"assets/app.js"})
	h := r.AssetHandler(inst)

	req := httptest.NewRequest("GET", "/assets/app.js", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}
