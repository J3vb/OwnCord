package admin_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// cappedBody wraps h the way the api router's body cap does, so a route sees
// an http.MaxBytesReader on r.Body.
func cappedBody(h http.Handler, limit int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		h.ServeHTTP(w, r)
	})
}

func decodeReply(t *testing.T, w *httptest.ResponseRecorder) (code, msg string) {
	t.Helper()
	var got struct{ Error, Message string }
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("body is not JSON: %v: %s", err, w.Body.String())
	}
	return got.Error, got.Message
}

// A body past the route's cap answers 413 PAYLOAD_TOO_LARGE on every admin
// route that reads JSON, and a body that does not decode answers 400
// BAD_REQUEST "malformed request body". Before MX-7 batch 2 the first was a
// 400 "invalid request body" and each route spelled the second its own way.
func TestAdminAPI_JSONBodyRoutes_OverTheCapIs413AndMalformedIs400(t *testing.T) {
	database := openMigratedAdminDB(t)
	svc := service.New(database, auth.NewRateLimiter())
	svc.Auth = service.NewAuthService(database, auth.NewRateLimiter(), nil, nil)
	handler := cappedBody(admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc), 1024)
	_, token := sessionFor(t, database, "decode-owner", 1)
	targetID, _ := sessionFor(t, database, "decode-target", 4)
	chID, err := database.CreateChannel(t.Context(), "decode-general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	routes := []struct{ name, method, path string }{
		{"create role", http.MethodPost, "/roles"},
		{"patch role", http.MethodPatch, "/roles/2"},
		{"reorder roles", http.MethodPatch, "/roles/reorder"},
		{"create channel", http.MethodPost, "/channels"},
		{"patch channel", http.MethodPatch, "/channels/" + itoa(chID)},
		{"create category", http.MethodPost, "/channels/categories"},
		{"reorder categories", http.MethodPut, "/channels/categories/order"},
		{"patch settings", http.MethodPatch, "/settings"},
		{"put afk channel", http.MethodPut, "/afk-channel"},
		{"create api token", http.MethodPost, "/tokens"},
		{"patch user", http.MethodPatch, "/users/" + itoa(targetID)},
		{"issue recovery credential", http.MethodPost, "/users/" + itoa(targetID) + "/recovery-credential"},
		{"put channel role permission", http.MethodPut, "/channels/" + itoa(chID) + "/permissions/2"},
		{"preview channel access", http.MethodPost, "/channels/" + itoa(chID) + "/access/preview"},
	}
	bodies := []struct {
		name, body string
		status     int
		code, msg  string
	}{
		{"malformed", `{"name":`, http.StatusBadRequest, "BAD_REQUEST", "malformed request body"},
		{"over the cap", `{"pad":"` + strings.Repeat("x", 4096) + `"}`, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "request body is too large"},
	}
	for _, rt := range routes {
		for _, b := range bodies {
			t.Run(rt.name+"/"+b.name, func(t *testing.T) {
				req := httptest.NewRequest(rt.method, rt.path, bytes.NewBufferString(b.body))
				req.Header.Set("Authorization", "Bearer "+token)
				req.Header.Set("Content-Type", "application/json")
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, req)
				code, msg := decodeReply(t, w)
				if w.Code != b.status || code != b.code || msg != b.msg {
					t.Errorf("%s %s = %d %q %q, want %d %q %q; body: %s",
						rt.method, rt.path, w.Code, code, msg, b.status, b.code, b.msg, w.Body.String())
				}
			})
		}
	}
}

// The support bundle routes keep their own 1 KiB cap, set inside the handler:
// no wrapper is needed, and a body past it is a 413 rather than the 400 it
// answered before.
func TestAdminAPI_SupportBundle_OverItsOneKiBCapIs413(t *testing.T) {
	database := supportTestDB(t)
	svc := service.New(database, auth.NewRateLimiter())
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)
	_, token := sessionFor(t, database, "bundle-owner", 1)

	cases := []struct {
		name, path, body string
		status           int
		code, msg        string
	}{
		{"preview over the cap", "/support-bundles/preview", `{"pad":"` + strings.Repeat("x", 2048) + `"}`, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "request body is too large"},
		{"download over the cap", "/support-bundles/download", `{"pad":"` + strings.Repeat("x", 2048) + `"}`, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "request body is too large"},
		{"preview padded after the value", "/support-bundles/preview", `{}` + strings.Repeat(" ", 2048) + `{}`, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "request body is too large"},
		{"preview unknown field", "/support-bundles/preview", `{"extra":1}`, http.StatusBadRequest, "BAD_REQUEST", "malformed request body"},
		{"preview trailing data", "/support-bundles/preview", `{}{}`, http.StatusBadRequest, "BAD_REQUEST", "malformed request body"},
		{"preview malformed", "/support-bundles/preview", `{`, http.StatusBadRequest, "BAD_REQUEST", "malformed request body"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, tc.path, bytes.NewBufferString(tc.body))
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			code, msg := decodeReply(t, w)
			if w.Code != tc.status || code != tc.code || msg != tc.msg {
				t.Errorf("%s = %d %q %q, want %d %q %q; body: %s", tc.path, w.Code, code, msg, tc.status, tc.code, tc.msg, w.Body.String())
			}
		})
	}
}
