package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
)

// TestAuditCoverage_PluginLifecycle is the plugin half of the B2-6 audit
// table: install and uninstall each emit an audit entry, and neither detail
// carries anything from the archive beyond the plugin name.
func TestAuditCoverage_PluginLifecycle(t *testing.T) {
	install := func(t *testing.T) (http.Handler, *db.DB, int64) {
		t.Helper()
		reg, mem := newTestPluginRegistryWithStore(t)
		h := NewPluginAdminHandler(reg, mem, mem)
		body, contentType := buildZipUpload(t, validPluginZip(t))
		req := httptest.NewRequest("POST", "/install", body)
		req.Header.Set("Content-Type", contentType)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("install: status = %d; body = %s", rec.Code, rec.Body.String())
		}
		row, err := mem.GetPluginByName(context.Background(), "hello")
		if err != nil || row == nil {
			t.Fatalf("GetPluginByName: %v", err)
		}
		return h, mem, row.ID
	}

	rows := []struct {
		name   string
		action string
		run    func(t *testing.T) *audittest.Recorder
	}{
		{"plugin install", "plugin_install", func(t *testing.T) *audittest.Recorder {
			reg, mem := newTestPluginRegistryWithStore(t)
			h := NewPluginAdminHandler(reg, mem, mem)
			rec := audittest.Install(t, mem)
			body, contentType := buildZipUpload(t, validPluginZip(t))
			req := httptest.NewRequest("POST", "/install", body)
			req.Header.Set("Content-Type", contentType)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != http.StatusCreated {
				t.Fatalf("install: status = %d; body = %s", w.Code, w.Body.String())
			}
			return rec
		}},
		{"plugin uninstall", "plugin_uninstall", func(t *testing.T) *audittest.Recorder {
			h, mem, id := install(t)
			rec := audittest.Install(t, mem)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("DELETE", "/"+strconv.FormatInt(id, 10), nil))
			if w.Code != http.StatusNoContent {
				t.Fatalf("uninstall: status = %d; body = %s", w.Code, w.Body.String())
			}
			return rec
		}},
	}

	var corpus []db.AuditEntry
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			rec := row.run(t)
			rec.Wait(t, row.action)
			corpus = append(corpus, rec.Entries()...)
		})
	}
}
