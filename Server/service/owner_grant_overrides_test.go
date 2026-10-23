package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// WP 8.4a (G1) for overrides: adding or removing MOVE_MEMBERS in a channel or
// category override's allow or deny is the owner's or an Administrator's.
// MANAGE_CHANNELS alone refuses it even when the actor holds the bit.

func moverChannelActor(t *testing.T, database *db.DB) (holder, admin *db.Role) {
	t.Helper()
	holder = &db.Role{ID: 31, Name: "chan-mover", Position: 50,
		Permissions: permissions.ManageChannels | permissions.ReadMessages | permissions.MoveMembers}
	admin = &db.Role{ID: 32, Name: "chan-super", Position: 90, Permissions: permissions.Administrator}
	seedRole(t, database, holder)
	seedRole(t, database, admin)
	return holder, admin
}

func TestRoleOverride_OwnerGrantOnlyBit(t *testing.T) {
	svc, database, _, low, ch := seedOverrideFixture(t)
	holder, admin := moverChannelActor(t, database)
	ctx := context.Background()

	for name, mask := range map[string][2]int64{"allow": {permissions.MoveMembers, 0}, "deny": {0, permissions.MoveMembers}} {
		_, err := svc.PutRoleOverride(ctx, 7, holder, ch, low.ID, mask[0], mask[1])
		if !errors.Is(err, ErrForbidden) || !strings.HasPrefix(err.Error(), "only the owner can change MOVE_MEMBERS") {
			t.Fatalf("%s: err = %v, want the owner-only refusal", name, err)
		}
	}
	if allow, deny, _ := database.GetChannelPermissions(ctx, ch.ID, low.ID); allow != 0 || deny != 0 {
		t.Fatalf("refused writes persisted (%#x,%#x)", allow, deny)
	}
	if _, err := svc.PutRoleOverride(ctx, 7, admin, ch, low.ID, permissions.MoveMembers, 0); err != nil {
		t.Fatalf("administrator add: %v", err)
	}
	// Removing the bit is refused to the holder too.
	if _, err := svc.DeleteRoleOverride(ctx, 7, holder, ch, low.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("holder delete err = %v, want ErrForbidden", err)
	}
	if _, err := svc.PutRoleOverride(ctx, 7, holder, ch, low.ID, permissions.ReadMessages, 0); !errors.Is(err, ErrForbidden) {
		t.Fatalf("holder overwrite err = %v, want ErrForbidden", err)
	}
	if _, err := svc.DeleteRoleOverride(ctx, 7, admin, ch, low.ID); err != nil {
		t.Fatalf("administrator delete: %v", err)
	}
}

func TestUserOverride_OwnerGrantOnlyBit(t *testing.T) {
	svc, database, _, _, ch := seedOverrideFixture(t)
	holder, admin := moverChannelActor(t, database)
	seedUser(t, database, &db.User{ID: 41, Username: "u41"})
	seedUserRole(t, database, 41, 22)
	ctx := context.Background()

	if _, err := svc.PutUserOverride(ctx, 7, holder, ch, 41, permissions.MoveMembers, 0); !errors.Is(err, ErrForbidden) {
		t.Fatalf("holder err = %v, want ErrForbidden", err)
	}
	if _, err := svc.PutUserOverride(ctx, 7, admin, ch, 41, permissions.MoveMembers, 0); err != nil {
		t.Fatalf("administrator: %v", err)
	}
	if _, err := svc.DeleteUserOverride(ctx, 7, holder, ch, 41); !errors.Is(err, ErrForbidden) {
		t.Fatalf("holder delete err = %v, want ErrForbidden", err)
	}
}

func TestCategoryOverride_OwnerGrantOnlyBit(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	holder := &db.Role{ID: 33, Name: "cat-mover", Position: 50,
		Permissions: permissions.ManageChannels | permissions.ReadMessages | permissions.MoveMembers}
	seedRole(t, f.database, holder)

	if _, err := f.svc.PutCategoryRoleOverride(ctx, 7, holder, f.cat.ID, f.low.ID, permissions.MoveMembers, 0); !errors.Is(err, ErrForbidden) {
		t.Fatalf("holder err = %v, want ErrForbidden", err)
	}
	if allow, deny := f.categoryRow(t, f.low.ID); allow != 0 || deny != 0 {
		t.Fatalf("refused write persisted (%#x,%#x)", allow, deny)
	}
	if _, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.admin, f.cat.ID, f.low.ID, permissions.MoveMembers, 0); err != nil {
		t.Fatalf("administrator: %v", err)
	}
	if _, err := f.svc.DeleteCategoryRoleOverride(ctx, 7, holder, f.cat.ID, f.low.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("holder delete err = %v, want ErrForbidden", err)
	}
}
