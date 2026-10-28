package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// Routes that used to answer a malformed body with different codes and
// messages (BAD_REQUEST "invalid request body", INVALID_INPUT "malformed JSON
// body", ...) and an over-size one with 400. They now share one reply each.
func TestJSONBodyRoutes_ShareOneReplyForTheSameBadBody(t *testing.T) {
	var database *db.DB
	router := setupRouterWithServices(t, func(_ *service.Services, d *db.DB) { database = d })
	uid := seedUser(t, database, "decoder", "decoderPass1", 4)
	token := seedSession(t, database, uid)

	routes := []struct{ method, path string }{
		{http.MethodPost, "/api/v1/dms"},
		{http.MethodPost, "/api/v1/dms/group"},
		{http.MethodPost, "/api/v1/reports"},
		{http.MethodPatch, "/api/v1/users/me"},
		{http.MethodPut, "/api/v1/users/me/password"},
	}
	bodies := []struct {
		name   string
		body   string
		status int
		code   string
		msg    string
	}{
		{"malformed", `{"recipient_id":`, http.StatusBadRequest, "INVALID_INPUT", "malformed request body"},
		{"over the cap", `{"pad":"` + strings.Repeat("x", 2<<20) + `"}`, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "request body is too large"},
	}
	for _, rt := range routes {
		for _, b := range bodies {
			req := httptest.NewRequest(rt.method, rt.path, bytes.NewBufferString(b.body))
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			rr := httptest.NewRecorder()
			router.ServeHTTP(rr, req)
			var got struct{ Error, Message string }
			_ = json.Unmarshal(rr.Body.Bytes(), &got)
			if rr.Code != b.status || got.Error != b.code || got.Message != b.msg {
				t.Errorf("%s %s, %s body: %d %q %q, want %d %q %q",
					rt.method, rt.path, b.name, rr.Code, got.Error, got.Message, b.status, b.code, b.msg)
			}
		}
	}
}
