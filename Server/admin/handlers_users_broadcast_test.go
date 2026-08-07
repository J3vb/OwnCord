package admin_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/owncord/server/admin"
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
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
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
