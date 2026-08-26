package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
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

// errGetChannelStore wraps a real *db.DB but fails GetChannel for one
// specific channel id, leaving every other call (including GetMessage) to
// hit the real database. Used to simulate a transient GetChannel error
// mid-request without disturbing the rest of the fixture.
type errGetChannelStore struct {
	*db.DB
	failChannelID int64
}

func (s errGetChannelStore) GetChannel(ctx context.Context, id int64) (*db.Channel, error) {
	if id == s.failChannelID {
		return nil, errors.New("boom")
	}
	return s.DB.GetChannel(ctx, id)
}

// TestHandleReaction_ChannelLookupErrorFailsClosed locks OC-0075: a
// GetChannel error during handleReaction must not be treated as "not a DM".
// Before the fix, isDM := chErr == nil && ch != nil && ch.Type == "dm" quietly
// became false on any lookup error, routing a DM message into the role-based
// permission branch. That branch checks HasChannelPerm against the base role
// mask (no channel-override rows exist for a DM), so any user with the
// ordinary READ_MESSAGES|ADD_REACTIONS member permissions could react inside
// a private DM they are not a participant of, and the reaction would be
// fanned out as a channel event instead of a DM event.
func TestHandleReaction_ChannelLookupErrorFailsClosed(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AddReactions,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUser(t, database, &db.User{ID: 3, Username: "mallory"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedUserRole(t, database, 3, permissions.MemberRoleID)

	permSvc := NewPermissionService(database, permissions.NewChecker(database))

	ch, _, err := database.GetOrCreateDMChannel(context.Background(), 1, 2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	msgID, err := database.CreateMessage(context.Background(), ch.ID, 1, "just us", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	failingStore := errGetChannelStore{DB: database, failChannelID: ch.ID}
	svc := NewMessageService(failingStore, permSvc, nil)

	// Mallory is not a DM participant, but carries the ordinary member role's
	// READ_MESSAGES|ADD_REACTIONS. With GetChannel failing, a fail-open
	// implementation lets this through as a non-DM reaction.
	if _, err := svc.AddReaction(context.Background(), 3, msgID, "👍"); err == nil {
		t.Fatal("AddReaction must fail when GetChannel errors mid-request, not fall open into the non-DM branch")
	}

	counts, err := database.GetReactions(context.Background(), msgID)
	if err != nil {
		t.Fatalf("GetReactions: %v", err)
	}
	if len(counts) != 0 {
		t.Fatalf("reaction must not be committed for a non-participant when the DM channel lookup failed, got %d reaction rows", len(counts))
	}
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
