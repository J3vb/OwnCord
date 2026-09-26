package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// The override policy at the service seam (B3-8 channel family, part 2).
// The admin surface's Test{Put,Delete}Channel*Permission_* rows pinned this
// policy through the extraction; these rows keep the seam itself covered so
// the guards cannot regress behind a future surface change.

func seedOverrideFixture(t *testing.T) (*ChannelService, *db.DB, *db.Role, *db.Role, *db.Channel) {
	t.Helper()
	database := newTestDB(t)
	svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))
	seedChannel(t, database, &db.Channel{ID: 60, Name: "guarded", Type: "text"})
	ch, err := svc.ResolveGuildChannel(context.Background(), 60)
	if err != nil {
		t.Fatalf("ResolveGuildChannel: %v", err)
	}
	// Actor: a mid-rank moderator WITHOUT ADMINISTRATOR; target: a lower role.
	mod := &db.Role{ID: 21, Name: "chan-mod", Position: 50,
		Permissions: permissions.ManageChannels | permissions.ReadMessages}
	low := &db.Role{ID: 22, Name: "chan-low", Position: 10, Permissions: permissions.ReadMessages}
	seedRole(t, database, mod)
	seedRole(t, database, low)
	return svc, database, mod, low, ch
}

func TestPutRoleOverride_ClampsAndPersists(t *testing.T) {
	svc, database, mod, low, ch := seedOverrideFixture(t)
	garbage := int64(1) << 62 // undefined bit must not persist
	res, err := svc.PutRoleOverride(context.Background(), 7, mod, ch, low.ID,
		permissions.ReadMessages|garbage, 0)
	if err != nil {
		t.Fatalf("PutRoleOverride: %v", err)
	}
	if res.Allow != permissions.ReadMessages {
		t.Fatalf("allow = %#x, want the defined bit alone", res.Allow)
	}
	allow, deny, err := database.GetChannelPermissions(context.Background(), ch.ID, low.ID)
	if err != nil || allow != permissions.ReadMessages || deny != 0 {
		t.Fatalf("persisted (%#x,%#x), %v", allow, deny, err)
	}
	if res.AffectedAll || res.Role == nil || res.Role.ID != low.ID {
		t.Fatalf("result = %+v", res)
	}
}

func TestPutRoleOverride_EscalationRefusedPrefixFree(t *testing.T) {
	svc, _, mod, low, ch := seedOverrideFixture(t)
	_, err := svc.PutRoleOverride(context.Background(), 7, mod, ch, low.ID,
		permissions.ManageServer, 0)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
	if !strings.HasPrefix(err.Error(), "cannot grant a permission your own role lacks") {
		t.Fatalf("message not prefix-free: %q", err.Error())
	}
}

func TestDeleteRoleOverride_ZeroMaskUnionGuard(t *testing.T) {
	// Clearing a deny the actor's own role lacks is a grant: seed a
	// MANAGE_SERVER deny as an admin would, then have the non-admin actor
	// try to clear it — the union guard must refuse.
	svc, database, mod, low, ch := seedOverrideFixture(t)
	if err := database.UpsertChannelOverride(context.Background(), ch.ID, low.ID, 0, permissions.ManageServer); err != nil {
		t.Fatalf("seed override: %v", err)
	}
	if _, err := svc.DeleteRoleOverride(context.Background(), 7, mod, ch, low.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden (clearing a foreign deny is a grant)", err)
	}
}

func TestRoleOverride_HierarchyRefusedAtOrAbove(t *testing.T) {
	svc, database, mod, _, ch := seedOverrideFixture(t)
	peer := &db.Role{ID: 23, Name: "chan-peer", Position: mod.Position, Permissions: permissions.ReadMessages}
	seedRole(t, database, peer)
	_, err := svc.PutRoleOverride(context.Background(), 7, mod, ch, peer.ID, permissions.ReadMessages, 0)
	if !errors.Is(err, ErrForbidden) || err.Error() != "cannot manage a role at or above your own rank" {
		t.Fatalf("err = %v, want the exact hierarchy refusal", err)
	}
}

func TestRoleOverride_UnknownRoleNotFound(t *testing.T) {
	svc, _, mod, _, ch := seedOverrideFixture(t)
	_, err := svc.PutRoleOverride(context.Background(), 7, mod, ch, 9999, 0, 0)
	if !errors.Is(err, ErrNotFound) || err.Error() != "role not found" {
		t.Fatalf("err = %v, want prefix-free role not found", err)
	}
}

func TestUserOverride_HierarchyAndAudit(t *testing.T) {
	svc, database, mod, low, ch := seedOverrideFixture(t)
	seedUser(t, database, &db.User{ID: 31, Username: "low-user"})
	seedUserRole(t, database, 31, low.ID)
	seedUser(t, database, &db.User{ID: 32, Username: "high-user"})
	seedUserRole(t, database, 32, 1) // Owner role, position 100

	res, err := svc.PutUserOverride(context.Background(), 7, mod, ch, 31, permissions.ReadMessages, 0)
	if err != nil {
		t.Fatalf("PutUserOverride: %v", err)
	}
	if len(res.AffectedUsers) != 1 || res.AffectedUsers[0] != 31 {
		t.Fatalf("affected = %v, want the one target", res.AffectedUsers)
	}

	if _, err := svc.PutUserOverride(context.Background(), 7, mod, ch, 32, 0, permissions.ReadMessages); !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden for a higher-ranked target", err)
	}
	if _, err := svc.PutUserOverride(context.Background(), 7, mod, ch, 9999, 0, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want user not found", err)
	}

	if _, err := svc.DeleteUserOverride(context.Background(), 7, mod, ch, 31); err != nil {
		t.Fatalf("DeleteUserOverride: %v", err)
	}
	entries, _ := database.GetAuditLog(context.Background(), 10, 0)
	var sawSet, sawClear bool
	for _, e := range entries {
		if e.Action == "channel_user_perms_update" {
			sawSet = true
		}
		if e.Action == "channel_user_perms_clear" {
			sawClear = true
		}
	}
	if !sawSet || !sawClear {
		t.Fatalf("audit rows: set=%v clear=%v, want both", sawSet, sawClear)
	}
}

func TestChannelPermissions_ListsRolesAndOnlyOverriddenUsers(t *testing.T) {
	svc, database, mod, low, ch := seedOverrideFixture(t)
	seedUser(t, database, &db.User{ID: 31, Username: "listed"})
	seedUserRole(t, database, 31, low.ID)
	if _, err := svc.PutUserOverride(context.Background(), 7, mod, ch, 31, permissions.ReadMessages, 0); err != nil {
		t.Fatalf("PutUserOverride: %v", err)
	}
	roles, users, err := svc.ChannelPermissions(context.Background(), ch.ID)
	if err != nil {
		t.Fatalf("ChannelPermissions: %v", err)
	}
	if len(roles) == 0 {
		t.Fatal("expected every role listed")
	}
	if len(users) != 1 || users[0].UserID != 31 {
		t.Fatalf("users = %+v, want only the overridden member", users)
	}
}
