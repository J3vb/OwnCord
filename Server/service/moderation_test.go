package service

import (
	"errors"
	"fmt"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/store"
)

// newTestModerationService seeds a MemStore with a role hierarchy:
// owner (pos 100, Administrator) > mod (pos 80, BanMembers) > member (pos 40).
// Users: 1=owner, 2=mod, 3=member, 4=member, 5=mod (equal rank to 2).
func newTestModerationService() (*ModerationService, *store.MemStore) {
	ms := store.NewMemStore()
	ms.SeedRole(&db.Role{ID: 1, Name: "owner", Permissions: permissions.Administrator, Position: 100})
	ms.SeedRole(&db.Role{ID: 2, Name: "mod", Permissions: permissions.BanMembers, Position: 80})
	ms.SeedRole(&db.Role{ID: 3, Name: "member", Permissions: permissions.SendMessages, Position: 40})
	for userID, roleID := range map[int64]int64{1: 1, 2: 2, 3: 3, 4: 3, 5: 2} {
		ms.SeedUserRole(userID, roleID)
		ms.SeedUser(&db.User{ID: userID, Username: fmt.Sprintf("u%d", userID), Status: "offline"})
	}
	checker := permissions.NewChecker(ms)
	return NewModerationService(ms, NewPermissionService(ms, checker)), ms
}

func TestBanUser_RequiresBanPermission(t *testing.T) {
	svc, _ := newTestModerationService()

	// A member without BAN_MEMBERS is refused.
	if err := svc.BanUser(3, 4, "nope", nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member ban attempt: want ErrForbidden, got %v", err)
	}
	// And gets Forbidden — not NotFound — for a nonexistent target, so the
	// ban path cannot be used to enumerate user ids.
	if err := svc.BanUser(3, 999, "probe", nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("unauthorized probe of missing id: want ErrForbidden, got %v", err)
	}
}

func TestBanUser_HierarchyEnforced(t *testing.T) {
	svc, ms := newTestModerationService()

	// Equal rank: mod cannot ban mod.
	if err := svc.BanUser(2, 5, "peer", nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("equal-rank ban: want ErrForbidden, got %v", err)
	}
	// Higher rank target: mod cannot ban the owner.
	if err := svc.BanUser(2, 1, "coup", nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("ban owner: want ErrForbidden, got %v", err)
	}
	owner, _ := ms.GetUserByID(1)
	if owner.Banned {
		t.Fatal("owner must not be banned")
	}
}

func TestBanUser_AuthorizedSucceeds(t *testing.T) {
	svc, ms := newTestModerationService()

	if err := svc.BanUser(2, 3, "spam", nil); err != nil {
		t.Fatalf("authorized ban: %v", err)
	}
	target, _ := ms.GetUserByID(3)
	if !target.Banned {
		t.Fatal("target should be banned")
	}
	if target.BanReason == nil || *target.BanReason != "spam" {
		t.Fatalf("ban reason not recorded: %v", target.BanReason)
	}

	// Authorized actor gets a real NotFound for a missing target.
	if err := svc.BanUser(2, 999, "gone", nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("authorized ban of missing id: want ErrNotFound, got %v", err)
	}
	// Self-ban is a bad request regardless of authority.
	if err := svc.BanUser(2, 2, "self", nil); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("self ban: want ErrBadRequest, got %v", err)
	}
}

func TestUnbanUser_AuthorizationMatrix(t *testing.T) {
	svc, ms := newTestModerationService()

	if err := svc.BanUser(1, 3, "setup", nil); err != nil {
		t.Fatalf("setup ban: %v", err)
	}

	// No BAN_MEMBERS → Forbidden (member 4 trying to unban member 3).
	if err := svc.UnbanUser(4, 3); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member unban: want ErrForbidden, got %v", err)
	}
	// Equal rank → Forbidden.
	if err := svc.UnbanUser(2, 5); !errors.Is(err, ErrForbidden) {
		t.Fatalf("equal-rank unban: want ErrForbidden, got %v", err)
	}
	// Authorized → succeeds.
	if err := svc.UnbanUser(2, 3); err != nil {
		t.Fatalf("authorized unban: %v", err)
	}
	target, _ := ms.GetUserByID(3)
	if target.Banned {
		t.Fatal("target should be unbanned")
	}
}
