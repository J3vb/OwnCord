package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
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

	w = doRequest(t, handler, http.MethodPut, "/channels/"+itoa(chID)+"/retention", ownerToken, map[string]int{"days": 14})
	if w.Code != http.StatusOK {
		t.Fatalf("PUT retention = %d: %s", w.Code, w.Body.String())
	}
	if w := doRequest(t, handler, http.MethodPut, "/channels/"+itoa(chID)+"/retention", ownerToken, map[string]int{"days": -3}); w.Code != http.StatusBadRequest {
		t.Errorf("negative days = %d, want 400", w.Code)
	}
	if w := doRequest(t, handler, http.MethodPut, "/channels/999999/retention", ownerToken, map[string]int{"days": 3}); w.Code != http.StatusNotFound {
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

	if w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID)+"/retention", ownerToken, nil); w.Code != http.StatusNoContent {
		t.Errorf("DELETE retention = %d, want 204", w.Code)
	}
	if w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID)+"/retention", ownerToken, nil); w.Code != http.StatusNotFound {
		t.Errorf("second DELETE = %d, want 404", w.Code)
	}
	// The server window through the settings route.
	if w := doRequest(t, handler, http.MethodPatch, "/settings", ownerToken, map[string]string{"retention_days": "5"}); w.Code != http.StatusOK {
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
