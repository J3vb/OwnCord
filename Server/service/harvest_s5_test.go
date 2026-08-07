package service

// Internal tests for the 2026-08-06 harvest S5 service findings: role-mutation
// read-check-write serialization and the mention badge stuck behind the
// latestID>0 gate in HandleChannelFocus.

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// rendezvousListStore pairs up two concurrent ListRoles calls so both read the
// same snapshot; a serialized caller waits out the timeout alone. This turns
// the create/create position race into a deterministic interleaving.
type rendezvousListStore struct {
	Store
	meet chan struct{}
}

func (s *rendezvousListStore) ListRoles(ctx context.Context) ([]*db.Role, error) {
	select {
	case s.meet <- struct{}{}:
	case <-s.meet:
	case <-time.After(150 * time.Millisecond):
	}
	return s.Store.ListRoles(ctx)
}

// Two concurrent default-position creates must not land on the same position:
// tied positions read as equal rank in every >=/<= hierarchy comparison, so
// CreateRole's read-check-write has to be serialized.
func TestCreateRole_ConcurrentCreatesCannotCollideOnPosition(t *testing.T) {
	_, database := newRoleCRUDService(t)
	svc := NewRoleService(
		&rendezvousListStore{Store: database, meet: make(chan struct{})},
		NewPermissionService(database, permissions.NewChecker(database)),
	)

	var wg sync.WaitGroup
	created := make([]*db.Role, 2)
	errs := make([]error, 2)
	for i, name := range []string{"RaceA", "RaceB"} {
		wg.Go(func() {
			created[i], errs[i] = svc.CreateRole(context.Background(), 2, RoleInput{Name: new(name)})
		})
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("CreateRole %d: %v", i, err)
		}
	}
	if created[0].Position == created[1].Position {
		t.Fatalf("two concurrent creates landed on position %d — tied roles read as equal rank and can never manage each other", created[0].Position)
	}
}

// erroringMembersStore fails exactly the role-member lookup.
type erroringMembersStore struct {
	Store
}

func (erroringMembersStore) ListUserIDsByRole(context.Context, int64) ([]int64, error) {
	return nil, context.DeadlineExceeded
}

// A failed member lookup must be distinguishable from "role has no members":
// the caller decides between per-user eviction and a blanket invalidation on it.
func TestAffectedUserIDs_LookupFailureReportsNotOK(t *testing.T) {
	_, database := newRoleCRUDService(t)
	svc := NewRoleService(erroringMembersStore{Store: database},
		NewPermissionService(database, permissions.NewChecker(database)))

	if ids, ok := svc.AffectedUserIDs(context.Background(), permissions.MemberRoleID); ok {
		t.Fatalf("AffectedUserIDs reported ok on a failed lookup (ids=%v) — the caller would evict nobody", ids)
	}
}

// channel_focus must clear the mention badge even when every message in the
// channel has been soft-deleted (GetLatestMessageID returns 0) — the badge is
// otherwise stuck and reasserted by every ready payload.
func TestHandleChannelFocus_ClearsMentionBadgeWhenAllMessagesDeleted(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.ReadMessages | permissions.SendMessages,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	ctx := context.Background()
	msgID, err := database.CreateMessage(ctx, 10, 2, "hey @alice", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if err := database.IncrementMentionCounts(ctx, 10, []int64{1}); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}
	if err := database.DeleteMessage(ctx, msgID, 2, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))
	if _, err := svc.HandleChannelFocus(ctx, 1, 10); err != nil {
		t.Fatalf("HandleChannelFocus: %v", err)
	}

	counts, err := database.GetChannelUnreadCounts(ctx, 1)
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts: %v", err)
	}
	if got := counts[10].MentionCount; got != 0 {
		t.Fatalf("mention_count = %d after focusing a channel whose messages were all deleted, want 0", got)
	}
}
