package service

import (
	"context"
	"errors"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// TestListVisibleChannels_OverrideFetchErrorFailsClosed is the uncached half of
// the same fail-open bug as TestHasChannelPerm_OverrideFetchErrorDenies: an
// empty override map here would list every channel the role is explicitly
// denied. The listing must error instead of leaking the denied channel.
func TestListVisibleChannels_OverrideFetchErrorFailsClosed(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AddReactions,
		Position:    1,
	})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "secret", Type: "text"})
	seedChannelOverride(t, database, permissions.MemberRoleID, 10, 0, permissions.ReadMessages)

	st := errOverrideStore{DB: database}
	permSvc := NewPermissionService(st, permissions.NewChecker(database))
	svc := NewChannelService(st, permSvc)

	// Either failing path is acceptable and both are ErrInternal: the permission
	// cache may short-circuit on its own fail-closed nil, or ListVisibleChannels'
	// own override branch may error. What must never happen is a 200 listing.
	got, err := svc.ListVisibleChannels(context.Background(), 1)
	if !errors.Is(err, ErrInternal) {
		t.Fatalf("ListVisibleChannels err = %v, want ErrInternal", err)
	}
	if got != nil {
		t.Fatalf("ListVisibleChannels returned %d channels on override fetch failure, want none", len(got))
	}
}
