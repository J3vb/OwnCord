package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// ─── PUT/DELETE /channels/{id}/user-permissions/{userId} ─────────────────────
//
// The per-user layer is gated on the same MANAGE_CHANNELS bit as the role
// layer, but invalidates only the TARGET's cached permissions — a per-user
// override cannot change anyone else's verdict.

func seedOverrideTarget(t *testing.T, database *db.DB, username string) int64 {
	t.Helper()
	uid := mustCreateUser(t, database, username, "$2a$12$placeholder", 3)
	return uid
}

func TestPutChannelUserPermission_PersistsInvalidatesAndAudits(t *testing.T) {
	database, hub, inv, handler, token := newPermHarness(t)
	target := seedOverrideTarget(t, database, "override-target")

	chID := mustCreateChannel(t, database, "secret", "text")

	body := map[string]any{"allow": permissions.ReadMessages, "deny": permissions.SendMessages}
	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/user-permissions/"+itoa(target), token, body)
	requireStatus(t, w, http.StatusOK)

	resp := decodeBody[db.ChannelUserOverride](t, w)
	if resp.UserID != target || resp.Username != "override-target" {
		t.Errorf("response = %+v, want user %d/override-target", resp, target)
	}
	if resp.Allow != permissions.ReadMessages || resp.Deny != permissions.SendMessages {
		t.Errorf("response masks = (%#x, %#x)", resp.Allow, resp.Deny)
	}

	allow, deny := channelUserPerms(t, database, chID, target)
	if allow != permissions.ReadMessages || deny != permissions.SendMessages {
		t.Errorf("persisted = (%#x, %#x)", allow, deny)
	}

	// Only the target's cache is dropped, and never the whole cache.
	if len(inv.invalidateUserIDs) != 1 || inv.invalidateUserIDs[0] != target {
		t.Errorf("InvalidateUser calls = %v, want [%d]", inv.invalidateUserIDs, target)
	}
	if inv.invalidateAllN != 0 {
		t.Errorf("InvalidateAll calls = %d, want 0", inv.invalidateAllN)
	}
	if len(hub.visibilityRefreshes) != 1 || hub.visibilityRefreshes[0].ID != chID {
		t.Errorf("RefreshChannelVisibility not called for channel %d", chID)
	}

	requireAuditAction(t, database, "channel_user_perms_update")
}

// A round trip through the endpoint must preserve the exact masks the matrix
// editor writes — one bit per row, in both directions at once.
func TestPutChannelUserPermission_MaskRoundTrip(t *testing.T) {
	database, handler, token := newAdminHarness(t)
	target := seedOverrideTarget(t, database, "matrix-target")

	chID := mustCreateChannel(t, database, "matrix", "text")

	allowMask := permissions.ReadMessages | permissions.AttachFiles | permissions.ConnectVoice | permissions.ShareScreen
	denyMask := permissions.SendMessages | permissions.AddReactions | permissions.MentionEveryone | permissions.SpeakVoice

	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/user-permissions/"+itoa(target), token,
		map[string]any{"allow": allowMask, "deny": denyMask})
	requireStatus(t, w, http.StatusOK)

	get := doRequest(t, handler, http.MethodGet, "/channels/"+itoa(chID)+"/permissions", token, nil)
	requireStatus(t, get, http.StatusOK)
	var listing struct {
		Users []db.ChannelUserOverride `json:"users"`
	}
	if err := json.Unmarshal(get.Body.Bytes(), &listing); err != nil {
		t.Fatalf("unmarshal listing: %v", err)
	}
	if len(listing.Users) != 1 {
		t.Fatalf("users = %d, want 1", len(listing.Users))
	}
	if listing.Users[0].Allow != allowMask || listing.Users[0].Deny != denyMask {
		t.Errorf("round trip = (%#x, %#x), want (%#x, %#x)",
			listing.Users[0].Allow, listing.Users[0].Deny, allowMask, denyMask)
	}
}

func TestPutChannelUserPermission_MasksUnknownBits(t *testing.T) {
	database, handler, token := newAdminHarness(t)
	target := seedOverrideTarget(t, database, "junk-target")

	chID := mustCreateChannel(t, database, "junk", "text")

	// 0x20000000 (bit 29) is not a defined bit — it must be dropped, not persisted.
	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/user-permissions/"+itoa(target), token,
		map[string]any{"allow": permissions.ReadMessages | 0x20000000, "deny": 0})
	requireStatus(t, w, http.StatusOK)
	allow, _ := channelUserPerms(t, database, chID, target)
	if allow != permissions.ReadMessages {
		t.Errorf("allow = %#x, want %#x (unknown bits dropped)", allow, permissions.ReadMessages)
	}
}

func TestPutChannelUserPermission_UnknownUser(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	chID := mustCreateChannel(t, database, "nope", "text")

	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/user-permissions/9999", token, map[string]any{"allow": 0, "deny": 2})
	expectStatus(t, w, http.StatusNotFound)
}

func TestPutChannelUserPermission_DMRejected(t *testing.T) {
	database, handler, token := newAdminHarness(t)
	target := seedOverrideTarget(t, database, "dm-target")

	chID := mustCreateChannel(t, database, "dm-1-2", "dm")

	// S-04: a DM id answers 404 like a missing id — see
	// TestS04_DMAndMissingChannelAnswerIdentically for the full pin.
	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/user-permissions/"+itoa(target), token, map[string]any{"allow": 0, "deny": 2})
	expectStatus(t, w, http.StatusNotFound)
}

func TestChannelUserPermission_NonAdminForbidden(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_ = createAdminUser(t, database)
	memberToken := createMemberUser(t, database)
	target := seedOverrideTarget(t, database, "forbidden-target")

	chID := mustCreateChannel(t, database, "gated", "text")

	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		w := doRequest(t, handler, method,
			"/channels/"+itoa(chID)+"/user-permissions/"+itoa(target), memberToken,
			map[string]any{"allow": 0, "deny": 2})
		if w.Code != http.StatusForbidden && w.Code != http.StatusUnauthorized {
			t.Errorf("%s status = %d, want 403/401; body: %s", method, w.Code, w.Body.String())
		}
	}

	// The refusal must not have written anything.
	allow, deny := channelUserPerms(t, database, chID, target)
	if allow != 0 || deny != 0 {
		t.Errorf("forbidden request persisted (%#x, %#x)", allow, deny)
	}
}

// A MANAGE_CHANNELS holder without ADMINISTRATOR must not be able to grant a
// permission bit their own role lacks (e.g. MANAGE_SERVER) to a member by
// writing it into a per-user channel override.
func TestPutChannelUserPermission_ModeratorCannotEscalate(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")
	target := seedOverrideTarget(t, database, "escalate-target")

	chID := mustCreateChannel(t, database, "escalate", "text")

	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/user-permissions/"+itoa(target), modToken,
		map[string]any{"allow": permissions.ManageServer, "deny": 0})
	requireStatus(t, w, http.StatusForbidden)

	allow, deny := channelUserPerms(t, database, chID, target)
	if allow != 0 || deny != 0 {
		t.Errorf("forbidden grant persisted: (%#x, %#x)", allow, deny)
	}
}

// A non-admin MANAGE_CHANNELS holder cannot write (or clear) a per-user
// override against a member whose role outranks their own, even for a bit they
// legitimately hold — the per-user layer is last in the resolution order, so
// without this guard a Moderator could deny a higher-ranked member channel
// access their role grants.
func TestPutChannelUserPermission_CannotTargetHigherRankedUser(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	// Actor: Moderator at position 60 holding MANAGE_CHANNELS + READ_MESSAGES.
	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "mod-hier")
	// Target holds a role ranked ABOVE the actor.
	seniorID, _ := createRoleUser(t, database, 11, "Senior", permissions.ReadMessages, 80, "senior-hier")

	chID := mustCreateChannel(t, database, "hier", "text")

	// deny READ_MESSAGES — a bit the Moderator holds, so the escalation guard
	// passes and only the hierarchy guard can stop this.
	put := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/user-permissions/"+itoa(seniorID), modToken,
		map[string]any{"allow": 0, "deny": permissions.ReadMessages})
	requireStatus(t, put, http.StatusForbidden)
	del := doRequest(t, handler, http.MethodDelete,
		"/channels/"+itoa(chID)+"/user-permissions/"+itoa(seniorID), modToken, nil)
	requireStatus(t, del, http.StatusForbidden)
	allow, deny := channelUserPerms(t, database, chID, seniorID)
	if allow != 0 || deny != 0 {
		t.Errorf("override persisted despite hierarchy guard: (%#x, %#x)", allow, deny)
	}
}

// An ADMINISTRATOR-holding actor can still grant any bit through a per-user
// override, since ADMINISTRATOR bypasses the escalation guard.
func TestPutChannelUserPermission_AdministratorCanGrantAnyBit(t *testing.T) {
	database, handler, token := newAdminHarness(t)
	target := seedOverrideTarget(t, database, "admin-grant-target")

	chID := mustCreateChannel(t, database, "admin-grant", "text")

	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/user-permissions/"+itoa(target), token,
		map[string]any{"allow": permissions.ManageServer, "deny": 0})
	requireStatus(t, w, http.StatusOK)

	allow, _ := channelUserPerms(t, database, chID, target)
	if allow != permissions.ManageServer {
		t.Errorf("allow = %#x, want %#x", allow, permissions.ManageServer)
	}
}

func TestDeleteChannelUserPermission_ClearsOverride(t *testing.T) {
	database, hub, inv, handler, token := newPermHarness(t)
	target := seedOverrideTarget(t, database, "clear-target")

	chID := mustCreateChannel(t, database, "clearme", "text")
	if err := database.UpsertChannelUserOverride(context.Background(), chID, target, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}

	w := doRequest(t, handler, http.MethodDelete,
		"/channels/"+itoa(chID)+"/user-permissions/"+itoa(target), token, nil)
	requireStatus(t, w, http.StatusNoContent)

	allow, deny := channelUserPerms(t, database, chID, target)
	if allow != 0 || deny != 0 {
		t.Errorf("override still present: (%#x, %#x)", allow, deny)
	}
	if len(inv.invalidateUserIDs) != 1 || inv.invalidateUserIDs[0] != target {
		t.Errorf("InvalidateUser calls = %v, want [%d]", inv.invalidateUserIDs, target)
	}
	if len(hub.visibilityRefreshes) != 1 {
		t.Errorf("RefreshChannelVisibility calls = %d, want 1", len(hub.visibilityRefreshes))
	}

	requireAuditAction(t, database, "channel_user_perms_clear")

	// Deleting again is idempotent.
	w = doRequest(t, handler, http.MethodDelete,
		"/channels/"+itoa(chID)+"/user-permissions/"+itoa(target), token, nil)
	expectStatus(t, w, http.StatusNoContent)
}

// Clearing a per-user override is a permission grant when it removes a deny
// bit the actor's own role does not hold, exactly like the role-layer case
// (TestDeleteChannelPermission_EscalationGuard in handlers_channel_perms_test.go).
// The DELETE handler must apply requireGrantableOverride to the override
// being REMOVED, not skip the escalation guard because hierarchy alone
// passes.
func TestDeleteChannelUserPermission_EscalationGuard(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	// Actor: MANAGE_CHANNELS holder without MANAGE_MESSAGES or ADMINISTRATOR.
	_, modToken := createRoleUser(t, database, 10, "Moderator", permissions.ManageChannels, 70, "moduser")
	target := seedOverrideTarget(t, database, "escalate-del-target")

	chID := mustCreateChannel(t, database, "escalate-del-user", "text")
	if err := database.UpsertChannelUserOverride(context.Background(), chID, target, 0, permissions.ManageMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}

	w := doRequest(t, handler, http.MethodDelete,
		"/channels/"+itoa(chID)+"/user-permissions/"+itoa(target), modToken, nil)
	requireStatus(t, w, http.StatusForbidden)

	allow, deny := channelUserPerms(t, database, chID, target)
	if allow != 0 || deny != permissions.ManageMessages {
		t.Errorf("override mutated by forbidden delete: (%#x, %#x)", allow, deny)
	}
}

// Same escalation, reached through a PUT that writes an all-zero mask: it
// still clears the existing deny bit, which is a grant
// (TestPutChannelPermission_ClearByZeroMaskEscalationGuard's per-user twin).
func TestPutChannelUserPermission_ClearByZeroMaskEscalationGuard(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, modToken := createRoleUser(t, database, 10, "Moderator", permissions.ManageChannels, 70, "moduser")
	target := seedOverrideTarget(t, database, "escalate-zero-target")

	chID := mustCreateChannel(t, database, "escalate-zero-user", "text")
	if err := database.UpsertChannelUserOverride(context.Background(), chID, target, 0, permissions.ManageMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}

	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/user-permissions/"+itoa(target), modToken,
		map[string]any{"allow": 0, "deny": 0})
	requireStatus(t, w, http.StatusForbidden)

	allow, deny := channelUserPerms(t, database, chID, target)
	if allow != 0 || deny != permissions.ManageMessages {
		t.Errorf("override mutated by forbidden zero-mask PUT: (%#x, %#x)", allow, deny)
	}
}
