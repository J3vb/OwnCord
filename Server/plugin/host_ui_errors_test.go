package plugin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestAssetHandler_RefusalsAreJSON pins MX-7 part 3: a declared asset that is
// a symlink or not a regular file is refused with the JSON envelope, not
// plain text.
func TestAssetHandler_RefusalsAreJSON(t *testing.T) {
	r, inst, dir := newAssetTestInstance(t, []string{"index.html"})
	if err := os.Mkdir(filepath.Join(dir, "folder"), 0o755); err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{"folder": "folder"}
	if err := os.Symlink(filepath.Join(dir, "index.html"), filepath.Join(dir, "link.html")); err == nil {
		cases["symlink"] = "link.html"
	} else {
		t.Logf("symlink case skipped: %v", err)
	}
	for _, asset := range cases {
		inst.Manifest.UI.Tabs = append(inst.Manifest.UI.Tabs, UITab{ID: "tab", Asset: asset})
	}
	h := r.AssetHandler(inst)

	for name, asset := range cases {
		t.Run(name, func(t *testing.T) {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "/"+asset, nil))
			if w.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403; body=%s", w.Code, w.Body.String())
			}
			if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
				t.Errorf("Content-Type = %q, want application/json", ct)
			}
			var env struct{ Error, Message string }
			if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil || env.Error != "FORBIDDEN" {
				t.Errorf("body = %s (%v), want the FORBIDDEN envelope", w.Body.String(), err)
			}
		})
	}
}
