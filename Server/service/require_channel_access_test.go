package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// PermissionService.RequireChannelAccess had no coverage. It is the single
// authorization gate that splits DM channels (membership check) from regular
// channels (role + override check); a wrong branch here either leaks a DM to a
// non-participant or locks legitimate users out of a channel.

func TestRequireChannelAccess_RegularChannel(t *testing.T) {
	svc, database := newTestPermService(t)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	ctx := context.Background()

	// The seeded Member role has SendMessages but not ManageChannels.
	if err := svc.RequireChannelAccess(ctx, 1, "text", 10, permissions.SendMessages); err != nil {
		t.Errorf("RequireChannelAccess with a granted permission = %v, want nil", err)
	}

	err := svc.RequireChannelAccess(ctx, 1, "text", 10, permissions.ManageChannels)
	if !errors.Is(err, permissions.ErrPermissionDenied) {
		t.Errorf("RequireChannelAccess with a missing permission = %v, want ErrPermissionDenied", err)
	}
}

func TestRequireChannelAccess_DMParticipant(t *testing.T) {
	svc, database := newTestPermService(t)
	seedChannel(t, database, &db.Channel{ID: 20, Name: "dm", Type: "dm"})
	seedDMParticipant(t, database, 20, 1)
	ctx := context.Background()

	// For a DM the permission argument is irrelevant — membership decides.
	// Pass a permission the Member role does not hold to prove that.
	if err := svc.RequireChannelAccess(ctx, 1, "dm", 20, permissions.ManageChannels); err != nil {
		t.Errorf("RequireChannelAccess for a DM participant = %v, want nil", err)
	}
}

func TestRequireChannelAccess_DMNonParticipant(t *testing.T) {
	svc, database := newTestPermService(t)
	seedChannel(t, database, &db.Channel{ID: 20, Name: "dm", Type: "dm"})
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedDMParticipant(t, database, 20, 1)
	ctx := context.Background()

	// User 2 is not in the DM. Role permissions must not open it.
	err := svc.RequireChannelAccess(ctx, 2, "dm", 20, permissions.ReadMessages)
	if !errors.Is(err, permissions.ErrNotDMParticipant) {
		t.Errorf("RequireChannelAccess for a non-participant = %v, want ErrNotDMParticipant", err)
	}
}

func TestRequireChannelAccess_DMWithNoParticipantsDenies(t *testing.T) {
	svc, database := newTestPermService(t)
	seedChannel(t, database, &db.Channel{ID: 21, Name: "empty-dm", Type: "dm"})
	ctx := context.Background()

	err := svc.RequireChannelAccess(ctx, 1, "dm", 21, permissions.ReadMessages)
	if !errors.Is(err, permissions.ErrNotDMParticipant) {
		t.Errorf("RequireChannelAccess on a DM with no participants = %v, want ErrNotDMParticipant", err)
	}
}

func TestRequireChannelAccess_UnknownUserDenied(t *testing.T) {
	svc, database := newTestPermService(t)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	ctx := context.Background()

	// A user with no row has no role, so getOrPopulate yields nothing and the
	// check must fail closed.
	err := svc.RequireChannelAccess(ctx, 9999, "text", 10, permissions.ReadMessages)
	if !errors.Is(err, permissions.ErrPermissionDenied) {
		t.Errorf("RequireChannelAccess for an unknown user = %v, want ErrPermissionDenied", err)
	}
}
