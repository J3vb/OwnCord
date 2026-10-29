package admin_test

import (
	"context"
	"net/http"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// WP 8.3e-2: the game activity switch is MANAGE_SERVER's, not the owner's, and
// a save hands the hub the stored value so it can clear shown games and tell
// open clients.
func TestPatchSettings_GameActivityEnabled_ManageServerAllowed_AppliesPolicy(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	_, manageToken := createRoleUser(t, database, 20, "ServerAdmin", permissions.ManageServer, 50, "gamanager")

	steps := []struct {
		value, stored string
		want          []bool
	}{
		{"FALSE", "false", []bool{false}},
		{"1", "true", []bool{false, true}},
	}
	for _, s := range steps {
		w := doRequest(t, handler, http.MethodPatch, "/settings", manageToken, map[string]string{"game_activity_enabled": s.value})
		if w.Code != http.StatusOK {
			t.Fatalf("MANAGE_SERVER PATCH game_activity_enabled=%s = %d, want 200; body: %s", s.value, w.Code, w.Body.String())
		}
		if got, err := database.GetSetting(context.Background(), "game_activity_enabled"); err != nil || got != s.stored {
			t.Errorf("stored after %q = %q, %v; want %q", s.value, got, err, s.stored)
		}
		if !slices.Equal(hub.gameActivityPolicies, s.want) {
			t.Fatalf("after %q the hub was told %v, want %v", s.value, hub.gameActivityPolicies, s.want)
		}
	}

	// A refused value changes nothing and tells nobody.
	if w := doRequest(t, handler, http.MethodPatch, "/settings", manageToken, map[string]string{"game_activity_enabled": "maybe"}); w.Code != http.StatusBadRequest {
		t.Errorf("PATCH an invalid value = %d, want 400; body: %s", w.Code, w.Body.String())
	}
	if len(hub.gameActivityPolicies) != 2 {
		t.Errorf("a refused save told the hub: %v", hub.gameActivityPolicies)
	}
}

func TestPatchSettings_OtherKey_DoesNotApplyGameActivityPolicy(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	_, manageToken := createRoleUser(t, database, 20, "ServerAdmin", permissions.ManageServer, 50, "gaother")

	if w := doRequest(t, handler, http.MethodPatch, "/settings", manageToken, map[string]string{"motd": "hello"}); w.Code != http.StatusOK {
		t.Fatalf("PATCH motd = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if len(hub.gameActivityPolicies) != 0 {
		t.Errorf("an unrelated save told the hub about game activity: %v", hub.gameActivityPolicies)
	}
}
