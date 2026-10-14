package admin

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

func TestHandlePatchSettings_LogsTheCauseOfA500(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	svc := service.NewSettingsService(database)
	if err := database.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	r := httptest.NewRequest(http.MethodPatch, "/admin/api/settings", strings.NewReader(`{"server_name":"x"}`))
	rec := httptest.NewRecorder()
	handlePatchSettings(svc, nil, nil).ServeHTTP(rec, r)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if !strings.Contains(buf.String(), "settings patch failed") || !strings.Contains(buf.String(), "closed") {
		t.Errorf("log = %q, want the failure and its cause", buf.String())
	}
	if strings.Contains(rec.Body.String(), "closed") {
		t.Errorf("body leaks the cause: %s", rec.Body.String())
	}
}
