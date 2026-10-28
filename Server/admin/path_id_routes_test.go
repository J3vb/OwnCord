package admin_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// Every admin route that reads a numeric id from its path refuses 0, a
// negative number and text with 400 BAD_REQUEST and that route's own message
// before it reaches a service. A valid-looking id that matches nothing would
// answer 404 (or 200 for a no-op write), so the 400 shows the handler
// returned before the lookup. MX-10: pathInt64 used to let 0 and negative ids
// through to the service on all of these routes.
func TestAdminAPI_PathIDRoutes_RefuseNonPositiveAndNonNumericIDs(t *testing.T) {
	database := openMigratedAdminDB(t)
	svc := service.New(database, auth.NewRateLimiter())
	svc.Auth = service.NewAuthService(database, auth.NewRateLimiter(), nil, nil)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)
	_, token := sessionFor(t, database, "pathid-owner", 1)
	chID, err := database.CreateChannel(t.Context(), "pathid-general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	ch := itoa(chID)

	// {id} and {x} stand for the id under test; ok is a real id of that kind
	// where a second path id must be valid for the first to be reached.
	routes := []struct {
		name, method, path, msg string
	}{
		{"rename category", http.MethodPatch, "/channels/categories/{id}", "invalid category id"},
		{"delete category", http.MethodDelete, "/channels/categories/{id}", "invalid category id"},
		{"get category permissions", http.MethodGet, "/channels/categories/{id}/permissions", "invalid category id"},
		{"put category role permission, category id", http.MethodPut, "/channels/categories/{id}/permissions/1", "invalid category id"},
		{"put category role permission, role id", http.MethodPut, "/channels/categories/1/permissions/{id}", "invalid role id"},
		{"delete category role permission, role id", http.MethodDelete, "/channels/categories/1/permissions/{id}", "invalid role id"},
		{"put category user permission, user id", http.MethodPut, "/channels/categories/1/user-permissions/{id}", "invalid user id"},
		{"delete category user permission, user id", http.MethodDelete, "/channels/categories/1/user-permissions/{id}", "invalid user id"},
		{"get channel permissions", http.MethodGet, "/channels/{id}/permissions", "invalid channel id"},
		{"put channel role permission, channel id", http.MethodPut, "/channels/{id}/permissions/1", "invalid channel id"},
		{"put channel role permission, role id", http.MethodPut, "/channels/" + ch + "/permissions/{id}", "invalid role id"},
		{"delete channel role permission, role id", http.MethodDelete, "/channels/" + ch + "/permissions/{id}", "invalid role id"},
		{"put channel user permission, user id", http.MethodPut, "/channels/" + ch + "/user-permissions/{id}", "invalid user id"},
		{"delete channel user permission, user id", http.MethodDelete, "/channels/" + ch + "/user-permissions/{id}", "invalid user id"},
		{"patch channel", http.MethodPatch, "/channels/{id}", "invalid channel id"},
		{"delete channel", http.MethodDelete, "/channels/{id}", "invalid channel id"},
		{"put channel retention", http.MethodPut, "/channels/{id}/retention", "invalid channel id"},
		{"delete channel retention", http.MethodDelete, "/channels/{id}/retention", "invalid channel id"},
		{"patch role", http.MethodPatch, "/roles/{id}", "invalid role id"},
		{"delete role", http.MethodDelete, "/roles/{id}", "invalid role id"},
		{"delete api token", http.MethodDelete, "/tokens/{id}", "invalid token id"},
		{"patch user", http.MethodPatch, "/users/{id}", "invalid user id"},
		{"delete user", http.MethodDelete, "/users/{id}", "invalid user id"},
		{"force logout", http.MethodDelete, "/users/{id}/sessions", "invalid user id"},
		{"add member role, user id", http.MethodPut, "/users/{id}/roles/1", "invalid user id"},
		{"add member role, role id", http.MethodPut, "/users/1/roles/{id}", "invalid role id"},
		{"remove member role, user id", http.MethodDelete, "/users/{id}/roles/1", "invalid user id"},
		{"remove member role, role id", http.MethodDelete, "/users/1/roles/{id}", "invalid role id"},
		{"issue recovery credential", http.MethodPost, "/users/{id}/recovery-credential", "invalid user id"},
		{"approve registration", http.MethodPost, "/registrations/{id}/approve", "invalid registration id"},
		{"deny registration", http.MethodPost, "/registrations/{id}/deny", "invalid registration id"},
	}
	for _, rt := range routes {
		for _, id := range []string{"0", "-1", "abc"} {
			t.Run(rt.name+"/"+id, func(t *testing.T) {
				path := strings.Replace(rt.path, "{id}", id, 1)
				w := doRequest(t, handler, rt.method, path, token, map[string]any{})
				if w.Code != http.StatusBadRequest {
					t.Fatalf("%s %s = %d, want 400; body: %s", rt.method, path, w.Code, w.Body.String())
				}
				var got struct{ Error, Message string }
				if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
					t.Fatalf("body is not JSON: %v: %s", err, w.Body.String())
				}
				if got.Error != "BAD_REQUEST" || got.Message != rt.msg {
					t.Errorf("%s %s = %q %q, want BAD_REQUEST %q", rt.method, path, got.Error, got.Message, rt.msg)
				}
			})
		}
	}
}
