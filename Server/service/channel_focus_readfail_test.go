package service

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// failLatestIDStore wraps a real *db.DB and makes GetLatestMessageID always
// fail, while counting calls to MarkChannelReadAtLatest, so the test can
// observe whether the read-state write still happens when the read-throttle
// optimisation's own read fails.
type failLatestIDStore struct {
	*db.DB
	writes atomic.Int64
}

func (s *failLatestIDStore) GetLatestMessageID(ctx context.Context, channelID int64) (int64, error) {
	return 0, errors.New("simulated GetLatestMessageID failure")
}

func (s *failLatestIDStore) MarkChannelReadAtLatest(ctx context.Context, userID, channelID int64) error {
	s.writes.Add(1)
	return s.DB.MarkChannelReadAtLatest(ctx, userID, channelID)
}

// TestHandleChannelFocus_WritesReadStateWhenLatestIDLookupFails locks OC-0436:
// a transient GetLatestMessageID failure must not skip the load-bearing
// MarkChannelReadAtLatest write. Before the fix, the write lived inside the
// same `if err == nil` block as the skip-decision read, so a failed
// GetLatestMessageID silently skipped the UPSERT entirely — read_states was
// never advanced, mention_count was never zeroed, nothing was logged, and
// HandleChannelFocus still returned success.
func TestHandleChannelFocus_WritesReadStateWhenLatestIDLookupFails(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	st := &failLatestIDStore{DB: database}
	svc := NewChannelService(st, NewPermissionService(database, permissions.NewChecker(database)))
	ctx := context.Background()

	ch, err := svc.HandleChannelFocus(ctx, 1, 10)
	if err != nil {
		t.Fatalf("HandleChannelFocus returned error %v, want nil (channel focus itself must still succeed)", err)
	}
	if ch == nil {
		t.Fatal("HandleChannelFocus returned nil channel")
	}

	if got := st.writes.Load(); got != 1 {
		t.Fatalf("MarkChannelReadAtLatest calls = %d, want 1 (the write must not be skipped when GetLatestMessageID fails)", got)
	}

	// Confirm the write actually landed: read_states must exist for this
	// user/channel now, not just that the mock was invoked.
	_, _, found, rsErr := database.GetReadState(ctx, 1, 10)
	if rsErr != nil {
		t.Fatalf("GetReadState: %v", rsErr)
	}
	if !found {
		t.Fatal("read_states row was not written despite GetLatestMessageID failing")
	}
}
