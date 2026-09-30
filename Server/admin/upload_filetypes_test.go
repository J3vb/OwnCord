package admin_test

import (
	"encoding/json"
	"net/http"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// The upload file-type lists are the owner's, like the backup policy: they
// decide which files members may share. A non-owner is refused; the Owner
// saves a normalized list.
func TestUploadFileTypeSettings_OwnerOnly(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, manageToken := createRoleUser(t, database, 20, "ServerAdmin", permissions.ManageServer, 50, "ftmanager")
	_, adminToken := createRoleUser(t, database, 21, "Administrator", permissions.Administrator, 90, "ftadministrator")
	_, ownerToken := createRoleUser(t, database, permissions.OwnerRoleID, "Owner", permissions.Administrator, 100, "ftowner")

	for _, key := range []string{"upload_blocked_extensions", "upload_allowed_extensions"} {
		for _, token := range []string{manageToken, adminToken} {
			if w := doRequest(t, handler, http.MethodPatch, "/settings", token, map[string]string{key: "png"}); w.Code != http.StatusForbidden {
				t.Errorf("non-owner PATCH %s = %d, want 403; body: %s", key, w.Code, w.Body.String())
			}
		}
		w := doRequest(t, handler, http.MethodPatch, "/settings", ownerToken, map[string]string{key: ".PNG, jpg"})
		if w.Code != http.StatusOK {
			t.Fatalf("Owner PATCH %s = %d, want 200; body: %s", key, w.Code, w.Body.String())
		}
		var got map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if got[key] != "png,jpg" {
			t.Errorf("%s = %q, want %q", key, got[key], "png,jpg")
		}
	}
	if w := doRequest(t, handler, http.MethodPatch, "/settings", ownerToken, map[string]string{"upload_allowed_extensions": "tar.gz"}); w.Code != http.StatusBadRequest {
		t.Errorf("PATCH an invalid extension = %d, want 400; body: %s", w.Code, w.Body.String())
	}
}

// The Settings page shows config.yaml's lists until the owner saves one, so
// GET /config reports them.
func TestAdminAPI_GetConfigFacts_UploadFileTypes(t *testing.T) {
	database := openAdminTestDB(t)
	cfg := &config.Config{Upload: config.UploadConfig{BlockedExtensions: []string{"bat", "ps1"}, AllowedExtensions: []string{}}}
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{RunningCfg: cfg})
	_, managerToken := createRoleUser(t, database, 12, "Manager", permissions.ManageServer, 50, "ftfacts")

	w := doRequest(t, handler, http.MethodGet, "/config", managerToken, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var got struct {
		Blocked []string `json:"upload_blocked_extensions"`
		Allowed []string `json:"upload_allowed_extensions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !slices.Equal(got.Blocked, []string{"bat", "ps1"}) || got.Allowed == nil || len(got.Allowed) != 0 {
		t.Errorf("config facts lists = %+v, want [bat ps1] and []; body: %s", got, w.Body.String())
	}
}
