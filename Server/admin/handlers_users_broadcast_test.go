package admin_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
)

// unbanMockHub wraps mockHub (admin/api_test.go) and additionally implements
// the optional memberUnbanBroadcaster capability handlePatchUser looks for
// via a type assertion, so these tests can observe whether an unban fired
// the mirror of BroadcastMemberBan.
type unbanMockHub struct {
	*mockHub
	unbannedIDs []int64
}

func (m *unbanMockHub) BroadcastMemberUnban(userID int64) {
	m.unbannedIDs = append(m.unbannedIDs, userID)
}

// An unban must tell every already-connected client the user is back in the
// roster — the mirror of the ban path's BroadcastMemberBan — or they stay
// missing from every connected client's member store until that client
// reconnects (v022).
func TestAdminAPI_PatchUser_UnbanBroadcastsMemberUnban(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &unbanMockHub{mockHub: &mockHub{}}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "unbanbroadcast", "hash", 3)

	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, map[string]any{
		"banned": true,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("ban: status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	w = doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, map[string]any{
		"banned": false,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("unban: status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	if len(hub.unbannedIDs) != 1 || hub.unbannedIDs[0] != targetUID {
		t.Fatalf("BroadcastMemberUnban calls = %v, want exactly [%d]", hub.unbannedIDs, targetUID)
	}
	if len(hub.memberBanIDs) != 1 || hub.memberBanIDs[0] != targetUID {
		t.Fatalf("BroadcastMemberBan calls = %v, want exactly [%d] (unaffected by the unban change)", hub.memberBanIDs, targetUID)
	}
}

// A role change must re-derive channel visibility for the promoted user, not
// just revoke what they can no longer read — otherwise a channel the new
// role newly gained READ_MESSAGES on never appears in their sidebar until
// they reconnect (v025).
func TestAdminAPI_PatchUser_RoleChangeRefreshesVisibility(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "rolerefresh", "hash", 3)

	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, map[string]any{
		"role_id": 2,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	if hub.allVisibilityRefreshes != 1 {
		t.Fatalf("RefreshAllChannelVisibility calls = %d, want 1", hub.allVisibilityRefreshes)
	}
	found := false
	for _, mu := range hub.memberUpdates {
		if mu.userID == targetUID {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a member_update for the role change, got %+v", hub.memberUpdates)
	}
}

// roleDeletingInvalidator simulates a second admin deleting the just-assigned
// role in the window between ModerationService.ChangeUserRole committing and
// handlePatchUser's own re-read of that role (used only for its name in the
// member_update payload). It hooks PermissionInvalidator.InvalidateUser
// because handlePatchUser calls that exactly once, synchronously, right
// after ChangeUserRole succeeds and right before the vulnerable re-read.
type roleDeletingInvalidator struct {
	database                     *db.DB
	deleteRoleID, fallbackRoleID int64
}

func (r *roleDeletingInvalidator) InvalidateUser(int64) {
	if _, err := r.database.DeleteRoleReassigning(context.Background(), r.deleteRoleID, r.fallbackRoleID); err != nil {
		panic(err) // test setup bug, not the behavior under test
	}
}
func (r *roleDeletingInvalidator) InvalidateAll() {}

// A role demotion's live-subscription revocation (BroadcastMemberUpdate ->
// revokeUnreadableChannels) and visibility re-derivation
// (RefreshAllChannelVisibility) must run whenever ChangeUserRole actually
// committed the role change, not only when a second, purely-cosmetic re-read
// of the role (done only to get its name) happens to still succeed. If the
// role is deleted out from under that re-read — a real admin racing a role
// deletion against this handler, or a transient read error — the demoted
// user's socket must not be left subscribed to channels it can no longer
// read (OC-0045).
func TestAdminAPI_PatchUser_RoleChangeBroadcastsEvenIfRoleReReadFails(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	invalidator := &roleDeletingInvalidator{database: database, deleteRoleID: 2, fallbackRoleID: 3}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, invalidator, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "roleracetarget", "hash", 3)

	// Promote the target to role 2 ("Admin"). The handler's own
	// InvalidateUser hook fires mid-request and deletes role 2 (reassigning
	// the target back to role 3 first, exactly like a real admin's DELETE
	// /admin/api/roles/2 would), so by the time handlePatchUser re-reads
	// role 2 for its name, GetRoleByID returns (nil, nil).
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, map[string]any{
		"role_id": 2,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	if hub.allVisibilityRefreshes != 1 {
		t.Fatalf("RefreshAllChannelVisibility calls = %d, want 1 (role change committed regardless of the re-read)", hub.allVisibilityRefreshes)
	}
	found := false
	for _, mu := range hub.memberUpdates {
		if mu.userID == targetUID {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a member_update for the role change despite the concurrent role deletion, got %+v", hub.memberUpdates)
	}
}
