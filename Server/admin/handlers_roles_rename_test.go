package admin_test

import (
	"net/http"
	"testing"
)

// Clients key a member's role by name, not id — a name-only PATCH leaves
// every member of the role holding a name that no longer resolves against
// the post-rename role list until a member_update re-keys them (v040).
func TestAdminAPI_PatchRole_RenameBroadcastsMemberUpdate(t *testing.T) {
	database := openAdminTestDB(t)
	handler, hub, _, token := newRolesHandler(t, database)

	// role id 3 is the seeded "Member" role; give it a holder before renaming.
	createUserWithRole(t, database, "renametest", 3)

	w := doRequest(t, handler, http.MethodPatch, "/roles/3", token, map[string]any{
		"name": "Mods",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	found := false
	for _, mu := range hub.memberUpdates {
		if mu.roleName == "Mods" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a member_update carrying the renamed role, got %+v", hub.memberUpdates)
	}
}

// A PATCH that changes nothing about the name must not emit a spurious
// member_update — only permission changes (handled separately) or a rename
// should.
func TestAdminAPI_PatchRole_NoRenameNoMemberUpdate(t *testing.T) {
	database := openAdminTestDB(t)
	handler, hub, _, token := newRolesHandler(t, database)

	createUserWithRole(t, database, "norenametest", 3)

	w := doRequest(t, handler, http.MethodPatch, "/roles/3", token, map[string]any{
		"color": "#abcdef",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	if len(hub.memberUpdates) != 0 {
		t.Fatalf("expected no member_update for a color-only patch, got %+v", hub.memberUpdates)
	}
}
