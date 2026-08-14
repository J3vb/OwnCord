package service

import (
	"context"
	"errors"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// errDMParticipantsStore wraps a real *db.DB but always fails
// GetDMParticipantIDs, so the fail-closed contract for OC-0069 is testable.
// Embedding *db.DB satisfies the service Store interface; only the one
// overridden method diverges, every other call still hits the real database.
type errDMParticipantsStore struct {
	*db.DB
}

func (errDMParticipantsStore) GetDMParticipantIDs(context.Context, int64) ([]int64, error) {
	return nil, errors.New("boom")
}

// TestHandleReaction_DMParticipantFetchErrorFailsClosed locks OC-0069: a DM
// reaction must not be persisted with no way to notify anyone. Before the
// fix, handleReaction committed AddReaction/RemoveReaction first and only
// then fetched GetDMParticipantIDs; a failure there was logged and
// swallowed, leaving the reaction row committed but result.ParticipantIDs
// nil, so reactionV2Handler fanned the reaction_update out to nobody while
// returning success to the caller. The fix must resolve participants before
// mutating and fail the whole request on error.
func TestHandleReaction_DMParticipantFetchErrorFailsClosed(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AddReactions,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 50, Name: "dm-1-2", Type: "dm"})
	seedDMParticipant(t, database, 50, 1)
	seedDMParticipant(t, database, 50, 2)

	permSvc := NewPermissionService(database, permissions.NewChecker(database))
	realSvc := NewMessageService(database, permSvc, nil)

	sent, err := realSvc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi bob",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	failingStore := errDMParticipantsStore{DB: database}
	svc := NewMessageService(failingStore, permSvc, nil)

	if _, err := svc.AddReaction(context.Background(), 1, sent.MessageID, "👋"); err == nil {
		t.Fatal("AddReaction must fail when GetDMParticipantIDs errors, not silently drop the fan-out")
	}

	counts, err := database.GetReactions(context.Background(), sent.MessageID)
	if err != nil {
		t.Fatalf("GetReactions: %v", err)
	}
	if len(counts) != 0 {
		t.Fatalf("reaction must not be committed when its fan-out cannot be resolved, got %d reaction rows", len(counts))
	}
}
