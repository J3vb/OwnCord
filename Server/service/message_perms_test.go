package service

import (
	"context"
	"errors"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// errDMChannelIDsStore wraps a real *db.DB but always fails
// GetUserDMChannelIDs, so GetAccessibleChannelIDs' fail-closed contract
// (OC-0087) is testable. Embedding *db.DB satisfies the service Store
// interface; only the overridden method diverges.
type errDMChannelIDsStore struct {
	*db.DB
}

func (errDMChannelIDsStore) GetUserDMChannelIDs(context.Context, int64) ([]int64, error) {
	return nil, errors.New("boom")
}

// TestGetAccessibleChannelIDs_DMLookupErrorFailsClosed locks OC-0087: a
// transient GetUserDMChannelIDs failure must not silently degrade the
// accessible-channel set to guild channels only. Before the fix the error was
// discarded (`if err == nil { ids = append(...) }`), so GetAccessibleChannelIDs
// returned (nil error, truncated set) and SearchMessages read back a
// successful-but-DM-stripped result — exactly the hole the ws sibling
// (computeAllowedChannels in ws/serve.go) was deliberately hardened against.
func TestGetAccessibleChannelIDs_DMLookupErrorFailsClosed(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	checker := permissions.NewChecker(database)
	svc := NewMessageService(errDMChannelIDsStore{database}, NewPermissionService(database, checker), nil)

	ids, err := svc.GetAccessibleChannelIDs(context.Background(), 1)
	if err == nil {
		t.Fatalf("expected an error when the DM lookup fails, got ids=%v, nil error", ids)
	}
	if !errors.Is(err, ErrInternal) {
		t.Fatalf("error = %v, want ErrInternal", err)
	}
}
