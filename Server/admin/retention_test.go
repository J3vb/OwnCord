package admin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

func TestAdminAPI_Retention_PolicyPreviewAndOverrides(t *testing.T) {
	database := openMigratedAdminDB(t)
	ctx := context.Background()
	svc := service.New(database, auth.NewRateLimiter())
	svc.Auth = service.NewAuthService(database, auth.NewRateLimiter(), nil, nil)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)
	_, ownerToken := sessionFor(t, database, "ret-owner", 1)
	_, memberToken := sessionFor(t, database, "ret-member", 4)
	chID, err := database.CreateChannel(ctx, "ret-general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}

	if w := doRequest(t, handler, http.MethodGet, "/retention", memberToken, nil); w.Code != http.StatusForbidden {
		t.Errorf("member GET /retention = %d, want 403", w.Code)
	}
	w := doRequest(t, handler, http.MethodGet, "/retention", ownerToken, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /retention = %d: %s", w.Code, w.Body.String())
	}
	var policy service.RetentionPolicy
	if err := json.Unmarshal(w.Body.Bytes(), &policy); err != nil || policy.ServerDays != 0 || len(policy.Channels) != 0 {
		t.Errorf("default policy = %+v, %v", policy, err)
	}

	w = applyAdminRetention(t, handler, ownerToken, service.RetentionChange{Scope: "channel", ChannelID: chID, Days: new(14)})
	if w.Code != http.StatusOK {
		t.Fatalf("PUT retention = %d: %s", w.Code, w.Body.String())
	}
	if w := doRequest(t, handler, http.MethodPut, "/channels/"+itoa(chID)+"/retention", ownerToken, map[string]int{"days": -3}); w.Code != http.StatusBadRequest {
		t.Errorf("negative days = %d, want 400", w.Code)
	}
	if w := requestAdminRetentionPreview(t, handler, ownerToken, service.RetentionChange{Scope: "channel", ChannelID: 999999, Days: new(3)}); w.Code != http.StatusNotFound {
		t.Errorf("unknown channel = %d, want 404", w.Code)
	}
	if w := doRequest(t, handler, http.MethodPut, "/channels/x/retention", ownerToken, map[string]int{"days": 3}); w.Code != http.StatusBadRequest {
		t.Errorf("bad id = %d, want 400", w.Code)
	}

	w = doRequest(t, handler, http.MethodGet, "/retention/preview", ownerToken, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /retention/preview = %d: %s", w.Code, w.Body.String())
	}
	var preview []service.RetentionPreview
	if err := json.Unmarshal(w.Body.Bytes(), &preview); err != nil || len(preview) != 1 || preview[0].ChannelID != chID || preview[0].Days != 14 || preview[0].WouldDelete != 0 {
		t.Errorf("preview = %+v, %v", preview, err)
	}

	if w := applyAdminRetention(t, handler, ownerToken, service.RetentionChange{Scope: "channel", ChannelID: chID}); w.Code != http.StatusNoContent {
		t.Errorf("DELETE retention = %d, want 204", w.Code)
	}
	if w := applyAdminRetention(t, handler, ownerToken, service.RetentionChange{Scope: "channel", ChannelID: chID}); w.Code != http.StatusNotFound {
		t.Errorf("second DELETE = %d, want 404", w.Code)
	}
	// The server window through the settings route.
	if w := applyAdminRetention(t, handler, ownerToken, service.RetentionChange{Scope: "server", Days: new(5)}); w.Code != http.StatusOK {
		t.Errorf("PATCH retention_days = %d: %s", w.Code, w.Body.String())
	}
	if w := doRequest(t, handler, http.MethodPatch, "/settings", ownerToken, map[string]string{"retention_days": "-5"}); w.Code != http.StatusBadRequest {
		t.Errorf("PATCH retention_days=-5 = %d, want 400", w.Code)
	}
	svc.Retention = nil
	closed := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)
	if w := doRequest(t, closed, http.MethodGet, "/retention", ownerToken, nil); w.Code != http.StatusInternalServerError {
		t.Errorf("without the service = %d, want 500", w.Code)
	}
}

func requestAdminRetentionPreview(t *testing.T, handler http.Handler, token string, change service.RetentionChange) *httptest.ResponseRecorder {
	t.Helper()
	w := doRequest(t, handler, http.MethodGet, "/retention", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("policy = %d: %s", w.Code, w.Body.String())
	}
	var policy service.RetentionPolicy
	if err := json.Unmarshal(w.Body.Bytes(), &policy); err != nil {
		t.Fatal(err)
	}
	return doRequest(t, handler, http.MethodPost, "/retention/preview", token, map[string]any{"proposed": change, "revision": policy.Revision})
}

func applyAdminRetention(t *testing.T, handler http.Handler, token string, change service.RetentionChange) *httptest.ResponseRecorder {
	t.Helper()
	w := requestAdminRetentionPreview(t, handler, token, change)
	if w.Code != http.StatusOK {
		t.Fatalf("preview = %d: %s", w.Code, w.Body.String())
	}
	var preview service.ProposedRetentionPreview
	if err := json.Unmarshal(w.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	return requestAdminRetentionApply(t, handler, token, change, preview.Token)
}

func requestAdminRetentionApply(t *testing.T, handler http.Handler, token string, change service.RetentionChange, preview string) *httptest.ResponseRecorder {
	t.Helper()
	method, path := http.MethodPut, "/channels/"+itoa(change.ChannelID)+"/retention"
	var body any = map[string]any{"days": change.Days}
	if change.Scope == "server" {
		method, path, body = http.MethodPatch, "/settings", map[string]string{"retention_days": itoa(int64(*change.Days))}
	} else if change.Days == nil {
		method, body = http.MethodDelete, nil
	}
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Retention-Preview", preview)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}

func TestAdminRetentionPreviewPermissionsAndConflicts(t *testing.T) {
	ctx := context.Background()
	database := openMigratedAdminDB(t)
	svc := service.New(database, auth.NewRateLimiter())
	svc.Auth = service.NewAuthService(database, auth.NewRateLimiter(), nil, nil)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)
	owner, token := sessionFor(t, database, "preview-admin", 1)
	_, otherToken := sessionFor(t, database, "preview-other", 1)
	_, memberToken := sessionFor(t, database, "preview-member", 4)
	channel, err := database.CreateChannel(ctx, "forever", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetChannelRetention(ctx, channel, 0, owner); err != nil {
		t.Fatal(err)
	}
	if err := database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "30"}); err != nil {
		t.Fatal(err)
	}
	change := service.RetentionChange{Scope: "channel", ChannelID: channel}
	getPreview := func() string {
		t.Helper()
		w := requestAdminRetentionPreview(t, handler, token, change)
		if w.Code != 200 {
			t.Fatalf("preview = %d: %s", w.Code, w.Body.String())
		}
		var preview service.ProposedRetentionPreview
		if err := json.Unmarshal(w.Body.Bytes(), &preview); err != nil {
			t.Fatal(err)
		}
		return preview.Token
	}
	preview := getPreview()
	if w := doRequest(t, handler, http.MethodPost, "/retention/preview", memberToken, nil); w.Code != 403 {
		t.Fatalf("member preview = %d", w.Code)
	}
	if w := requestAdminRetentionApply(t, handler, otherToken, change, preview); w.Code != 400 {
		t.Fatalf("other actor apply = %d", w.Code)
	}
	if w := requestAdminRetentionApply(t, handler, token, change, ""); w.Code != 400 {
		t.Fatalf("unpreviewed apply = %d", w.Code)
	}
	// A second admin changes the server window. Removing the old indefinite
	// override must not silently inherit a policy the first admin never saw.
	if w := applyAdminRetention(t, handler, otherToken, service.RetentionChange{Scope: "server", Days: new(7)}); w.Code != 200 {
		t.Fatalf("other edit = %d: %s", w.Code, w.Body.String())
	}
	w := requestAdminRetentionApply(t, handler, token, change, preview)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "STALE_RETENTION_POLICY") || !strings.Contains(w.Body.String(), "nothing was saved") {
		t.Fatalf("stale apply = %d: %s", w.Code, w.Body.String())
	}
	policy, _ := database.GetChannelRetention(ctx, channel)
	if policy == nil || policy.Days != 0 {
		t.Fatal("stale apply removed protection")
	}
	// Same session token, freshly resolved permissions after preview.
	preview = getPreview()
	if _, err := database.ExecContext(ctx, `UPDATE users SET role_id = 4 WHERE id = ?`, owner); err != nil {
		t.Fatal(err)
	}
	if w := requestAdminRetentionApply(t, handler, token, change, preview); w.Code != 403 {
		t.Fatalf("demoted apply = %d: %s", w.Code, w.Body.String())
	}
	policy, _ = database.GetChannelRetention(ctx, channel)
	if policy == nil || policy.Days != 0 {
		t.Fatal("demoted apply removed protection")
	}
	// The legacy PATCH cannot bypass previews or partially apply mixed settings.
	if w := doRequest(t, handler, http.MethodPatch, "/settings", otherToken, map[string]string{"retention_days": "1", "motd": "must not save"}); w.Code != 400 {
		t.Fatalf("mixed PATCH = %d", w.Code)
	}
	if w := requestAdminRetentionApply(t, handler, otherToken, service.RetentionChange{Scope: "server", Days: new(1)}, ""); w.Code != 400 {
		t.Fatalf("unpreviewed PATCH = %d", w.Code)
	}
}
