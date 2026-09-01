package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// The admin panel's user reads moved behind UserService with the B3-8 user
// family. These pin the two contracts the handlers now rely on rather than
// implement themselves: a missing user is ErrNotFound (not a nil row the
// caller has to remember to check), and the role name attached to a user is
// best-effort — a user whose role is unresolvable is still returned, because
// the panel has to be able to show and act on exactly such a user.

func TestUserService_GetReportsMissingAsNotFound(t *testing.T) {
	database := newTestDB(t)
	svc := NewUserService(database)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 1, Username: "present"})

	got, err := svc.Get(ctx, 1)
	if err != nil || got == nil || got.Username != "present" {
		t.Fatalf("Get(existing) = %+v, %v", got, err)
	}

	_, err = svc.Get(ctx, 4242)
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("Get(missing) error = %v, want ErrNotFound", err)
	}
}

func TestUserService_GetWithRoleName(t *testing.T) {
	database := newTestDB(t)
	svc := NewUserService(database)
	ctx := context.Background()
	seedRole(t, database, &db.Role{ID: 7, Name: "Helper", Position: 20})
	seedUser(t, database, &db.User{ID: 1, Username: "helper-holder"})
	seedUserRole(t, database, 1, 7)

	user, roleName, err := svc.GetWithRoleName(ctx, 1)
	if err != nil {
		t.Fatalf("GetWithRoleName: %v", err)
	}
	if user.ID != 1 || roleName != "Helper" {
		t.Errorf("got (id=%d, role=%q), want (1, \"Helper\")", user.ID, roleName)
	}

	// A user pointing at a role row that does not exist still comes back —
	// with an empty name rather than an error, which is what keeps such a user
	// fixable from the panel instead of invisible to it.
	seedUser(t, database, &db.User{ID: 2, Username: "orphan"})
	// The schema's foreign key would refuse this state; it is reachable in a
	// real database through a role deleted out from under a user by a path
	// that does not reassign, so the read has to cope with it either way.
	if _, err := database.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		t.Fatalf("disabling foreign keys: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE users SET role_id = 999 WHERE id = 2`); err != nil {
		t.Fatalf("pointing the user at a missing role: %v", err)
	}
	user, roleName, err = svc.GetWithRoleName(ctx, 2)
	if err != nil {
		t.Fatalf("GetWithRoleName(orphan): %v — a missing role must not fail the user read", err)
	}
	if user.ID != 2 || roleName != "" {
		t.Errorf("got (id=%d, role=%q), want (2, \"\")", user.ID, roleName)
	}

	// The not-found contract is inherited from Get.
	if _, _, err := svc.GetWithRoleName(ctx, 4242); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetWithRoleName(missing) error = %v, want ErrNotFound", err)
	}
}

func TestUserService_ListAllAndServerStats(t *testing.T) {
	database := newTestDB(t)
	svc := NewUserService(database)
	ctx := context.Background()
	seedRole(t, database, &db.Role{ID: permissions.MemberRoleID, Name: "Member", Position: 10})
	for i := int64(1); i <= 3; i++ {
		seedUser(t, database, &db.User{ID: i})
		seedUserRole(t, database, i, permissions.MemberRoleID)
	}

	page, err := svc.ListAll(ctx, 2, 0)
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	if len(page) != 2 {
		t.Errorf("ListAll(limit=2) returned %d rows, want 2 — the caller's bound is honoured", len(page))
	}

	// The offset is the caller's too: page two of a 3-row set holds the rest.
	rest, err := svc.ListAll(ctx, 2, 2)
	if err != nil {
		t.Fatalf("ListAll(offset): %v", err)
	}
	if len(rest) != 1 {
		t.Errorf("ListAll(limit=2, offset=2) returned %d rows, want 1", len(rest))
	}

	stats, err := svc.ServerStats(ctx)
	if err != nil || stats == nil {
		t.Fatalf("ServerStats: %v, %+v", err, stats)
	}
	if stats.UserCount != 3 {
		t.Errorf("UserCount = %d, want 3", stats.UserCount)
	}
	// The live connection count is hub state, not a row: the service leaves it
	// at zero and the handler stamps it.
	if stats.OnlineCount != 0 {
		t.Errorf("OnlineCount = %d, want 0 — the hub count is the caller's to stamp", stats.OnlineCount)
	}
}

// A failed read is an internal error, never an empty result that would render
// as "no users" or a zeroed dashboard.
func TestUserService_AdminReadsFailLoud(t *testing.T) {
	database := newTestDB(t)
	svc := NewUserService(database)
	ctx := context.Background()
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if _, err := svc.ListAll(ctx, 10, 0); !errors.Is(err, ErrInternal) {
		t.Errorf("ListAll on a closed database: err = %v, want ErrInternal", err)
	}
	if _, err := svc.ServerStats(ctx); !errors.Is(err, ErrInternal) {
		t.Errorf("ServerStats on a closed database: err = %v, want ErrInternal", err)
	}
	if _, err := svc.Get(ctx, 1); !errors.Is(err, ErrInternal) {
		t.Errorf("Get on a closed database: err = %v, want ErrInternal", err)
	}
}
