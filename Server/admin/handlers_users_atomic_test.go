package admin_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
)

// A PATCH combining banned + role_id must be all-or-nothing: if the role
// change is refused, the ban must not have been committed either. Before the
// fix, handlePatchUser applied and broadcast the ban first and only then
// attempted the role change, so a moderator with BAN_MEMBERS but not
// MANAGE_ROLES could send one PATCH that the API reports as a 403 failure
// while the target ends up banned, audited, and dropped from every connected
// client's member list anyway (OC-0215).
func TestAdminAPI_PatchUser_RefusedRoleChangeDoesNotLeaveBanCommitted(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database), newTestSettingsService(database))

	// Moderator: BAN_MEMBERS (and everything below bit 20), but not
	// MANAGE_ROLES (bit 24) — moderatorMask is perm_gates_test.go's constant
	// for exactly this shape, seeded at position 60 (below Admin's 80).
	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")

	targetUID, err := database.CreateUser(context.Background(), "atomictarget", "hash", 3) // Member, position 40
	if err != nil {
		t.Fatalf("CreateUser target: %v", err)
	}

	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), modToken, map[string]any{
		"banned":     true,
		"ban_reason": "spam",
		"role_id":    2, // Admin role — moderator lacks MANAGE_ROLES to grant it
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (moderator lacks MANAGE_ROLES); body: %s", w.Code, w.Body.String())
	}

	target, err := database.GetUserByID(context.Background(), targetUID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if target == nil {
		t.Fatalf("target user disappeared")
	}
	if target.Banned {
		t.Fatalf("target.Banned = true, want false: the refused role change must not leave the ban committed")
	}
	if len(hub.memberBanIDs) != 0 {
		t.Fatalf("BroadcastMemberBan calls = %v, want none: no ban should have been broadcast for a request the API reported as failed", hub.memberBanIDs)
	}
}
