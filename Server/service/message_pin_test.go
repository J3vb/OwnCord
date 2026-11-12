package service

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// mustPin pins (or unpins) and requires a result, since every caller here
// goes on to read the pin row or its audience.
func mustPin(ctx context.Context, t *testing.T, svc interface {
	SetMessagePinned(ctx context.Context, userID, channelID, msgID int64, pinned bool) (*PinEventResult, error)
}, label string, userID, channelID, msgID int64, pinned bool) *PinEventResult {
	t.Helper()
	res, err := svc.SetMessagePinned(ctx, userID, channelID, msgID, pinned)
	if err != nil || res == nil {
		t.Fatalf("%s: res = %v, err = %v", label, res, err)
	}
	return res
}

// dmWithMessage opens the member DM and has from post "hi" in it.
func (f *moderationActionsFixture) dmWithMessage(ctx context.Context, t *testing.T, from int64, username string) (*CreateDMResult, *SendMessageResult) {
	t.Helper()
	direct, err := NewDMService(f.database, f.mod.perms).CreateDM(ctx, fixtureMember, fixtureMember2)
	mustDo(t, "CreateDM", err)
	sent := mustSendMessage(ctx, t, f.messages, SendMessageParams{
		ChannelID: direct.Channel.ID, UserID: from, Username: username, Content: "hi",
	})
	return direct, sent
}

// sortedIDs copies ids before sorting so the result under test is not mutated.
func sortedIDs(ids []int64) []int64 {
	out := append([]int64(nil), ids...)
	slices.Sort(out)
	return out
}

// pinFixture is two users, a member and a role moderator, in one text channel
// holding one message, so the channel-override tests change only the verdict
// under test.
func pinFixture(t *testing.T) (svc *MessageService, permSvc *PermissionService, database *db.DB, msgID int64) {
	t.Helper()
	database = newTestDB(t)
	seedRole(t, database, &db.Role{
		ID: permissions.ModeratorRoleID, Name: "moderator", Position: 10,
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.ManageMessages,
	})
	seedRole(t, database, &db.Role{
		ID: permissions.MemberRoleID, Name: "member", Position: 1,
		Permissions: permissions.SendMessages | permissions.ReadMessages,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "mod_bob"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.ModeratorRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	permSvc = NewPermissionService(database, permissions.NewChecker(database))
	svc = NewMessageService(database, permSvc, nil)
	sent := mustSendMessage(context.Background(), t, svc, SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", Content: "pin me",
	})
	return svc, permSvc, database, sent.MessageID
}

// A channel override decides who may pin, on both layers: a user-level deny of
// MANAGE_MESSAGES refuses a role moderator, and a user-level allow lets a plain
// member pin. The same predicate feeds the can_pin affordance.
func TestSetMessagePinned_FollowsChannelOverride(t *testing.T) {
	svc, permSvc, database, msgID := pinFixture(t)
	ctx := context.Background()

	seedChannelUserOverride(t, database, 2, 10, 0, permissions.ManageMessages)
	permSvc.InvalidateChannel(10)
	if _, err := svc.SetMessagePinned(ctx, 2, 10, msgID, true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator with a user deny of MANAGE pinned: err = %v, want ErrForbidden", err)
	}

	if _, err := svc.SetMessagePinned(ctx, 1, 10, msgID, true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member without MANAGE pinned: err = %v, want ErrForbidden", err)
	}
	seedChannelUserOverride(t, database, 1, 10, permissions.ManageMessages, 0)
	permSvc.InvalidateChannel(10)
	if _, err := svc.SetMessagePinned(ctx, 1, 10, msgID, true); err != nil {
		t.Fatalf("member with a user allow of MANAGE must pin: %v", err)
	}
	pinned, err := database.GetPinnedMessages(ctx, 10, 1)
	if err != nil || len(pinned) != 1 {
		t.Fatalf("pinned = %d, %v; want exactly one pin", len(pinned), err)
	}
}

// The pin error codes are unchanged by routing through CanPinMessage: a DM
// non-participant is ErrNotFound, a block and a timeout keep their own kinds,
// and a refusal in a text channel is ErrForbidden.
func TestSetMessagePinned_ErrorsUnchanged(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()
	direct, dmSent := f.dmWithMessage(ctx, t, fixtureMember2, "u5")
	seedChannel(t, f.database, &db.Channel{ID: 900, Name: "pin-errors", Type: "text"})
	textSent := mustSendMessage(ctx, t, f.messages, SendMessageParams{
		ChannelID: 900, UserID: fixtureMember, Username: "u3", Content: "hello",
	})

	if _, err := f.messages.SetMessagePinned(ctx, fixtureOwner, direct.Channel.ID, dmSent.MessageID, true); !errors.Is(err, ErrNotFound) {
		t.Errorf("DM non-participant (even an administrator) = %v, want ErrNotFound", err)
	}
	if _, err := f.messages.SetMessagePinned(ctx, fixtureMember, 900, textSent.MessageID, true); !errors.Is(err, ErrForbidden) {
		t.Errorf("text channel without MANAGE = %v, want ErrForbidden", err)
	}

	seedBlock(t, f.database, fixtureMember2, fixtureMember)
	if _, err := f.messages.SetMessagePinned(ctx, fixtureMember, direct.Channel.ID, dmSent.MessageID, true); !errors.Is(err, ErrBlocked) {
		t.Errorf("DM pin while blocked = %v, want ErrBlocked", err)
	}
	if _, err := f.database.ExecContext(ctx, `DELETE FROM user_blocks`); err != nil {
		t.Fatalf("clear blocks: %v", err)
	}

	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	if _, err := f.messages.SetMessagePinned(ctx, fixtureMember, direct.Channel.ID, dmSent.MessageID, true); !errors.Is(err, ErrTimedOut) {
		t.Errorf("DM pin while timed out = %v, want ErrTimedOut", err)
	}
}

// A pin in a text channel returns the pin row with its author and no
// participants; a re-pin and an unpin return none (WP 6.12).
func TestSetMessagePinned_ChannelReturnsRowOnce(t *testing.T) {
	svc, _, database, msgID := pinFixture(t)
	ctx := context.Background()

	res := mustPin(ctx, t, svc, "pin", 2, 10, msgID, true)
	if res.IsDM || len(res.ParticipantIDs) != 0 {
		t.Errorf("channel result: IsDM = %v participants = %v, want a channel result", res.IsDM, res.ParticipantIDs)
	}
	if res.Author == nil || res.Author.ID != 2 || res.AuthorRole != "moderator" {
		t.Errorf("author = %+v role %q, want user 2 (moderator)", res.Author, res.AuthorRole)
	}
	if res.Row.PinnedMessageID != msgID || res.Row.Content != "mod_bob pinned a message to this channel." {
		t.Errorf("row = %+v", res.Row)
	}
	if again, err := svc.SetMessagePinned(ctx, 2, 10, msgID, true); err != nil || again != nil {
		t.Errorf("re-pin: res = %v, err = %v, want nil, nil", again, err)
	}
	if un, err := svc.SetMessagePinned(ctx, 2, 10, msgID, false); err != nil || un != nil {
		t.Errorf("unpin: res = %v, err = %v, want nil, nil", un, err)
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE kind = 7`).Scan(&n); err != nil || n != 1 {
		t.Errorf("pin rows = %d (err %v), want 1", n, err)
	}
}

func TestSetMessagePinned_DMReturnsParticipants(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()
	direct, sent := f.dmWithMessage(ctx, t, fixtureMember2, "u5")
	res := mustPin(ctx, t, f.messages, "pin", fixtureMember, direct.Channel.ID, sent.MessageID, true)
	if !res.IsDM {
		t.Error("IsDM = false for a DM pin")
	}
	got := sortedIDs(res.ParticipantIDs)
	want := []int64{fixtureMember, fixtureMember2}
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("participants = %v, want %v", got, want)
	}
	if res.Row.ChannelID != direct.Channel.ID || res.Row.PinnedMessageID != sent.MessageID {
		t.Errorf("row = %+v", res.Row)
	}
}

// A pin row is deletable by its author in a channel like an ordinary message
// and by no one once deleted; a pin of a pin row is refused.
func TestPinRow_DeleteAndPinRules(t *testing.T) {
	svc, _, _, msgID := pinFixture(t)
	ctx := context.Background()
	res := mustPin(ctx, t, svc, "pin", 2, 10, msgID, true)
	rowID := res.Row.MessageID
	if _, err := svc.SetMessagePinned(ctx, 2, 10, rowID, true); !errors.Is(err, ErrBadRequest) {
		t.Errorf("pin a pin row = %v, want ErrBadRequest", err)
	}
	// A plain member without MANAGE_MESSAGES may not delete the moderator's row.
	if _, err := svc.DeleteMessage(ctx, 1, rowID); !errors.Is(err, ErrForbidden) {
		t.Errorf("member delete of another's pin row = %v, want ErrForbidden", err)
	}
	if _, err := svc.DeleteMessage(ctx, 2, rowID); err != nil {
		t.Errorf("author delete of own pin row = %v, want nil", err)
	}
}

// A pin row in a one-to-one DM follows the delivery audience: while the
// recipient has not accepted the sender's request it reaches only the pinner,
// and once they trust the pinner it reaches both.
func TestSetMessagePinned_DMPendingRequestAudience(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()
	f.messages.SetMessageRequests(NewMessageRequestService(f.database, NewBlockService(f.database)))
	direct, sent := f.dmWithMessage(ctx, t, fixtureMember, "u3")
	res := mustPin(ctx, t, f.messages, "pin", fixtureMember, direct.Channel.ID, sent.MessageID, true)
	if !slices.Equal(res.ParticipantIDs, []int64{fixtureMember}) {
		t.Errorf("audience with a pending request = %v, want only the pinner %d", res.ParticipantIDs, fixtureMember)
	}

	mustDo(t, "TrustSender", f.database.TrustSender(ctx, fixtureMember2, fixtureMember, "accepted"))
	if _, err := f.messages.SetMessagePinned(ctx, fixtureMember, direct.Channel.ID, sent.MessageID, false); err != nil {
		t.Fatalf("unpin: %v", err)
	}
	// Move the first row out of the window so a fresh pin writes another.
	if _, err := f.database.ExecContext(ctx, `UPDATE messages SET timestamp = '2000-01-01 00:00:00' WHERE kind = 7`); err != nil {
		t.Fatalf("backdate: %v", err)
	}
	res = mustPin(ctx, t, f.messages, "re-pin", fixtureMember, direct.Channel.ID, sent.MessageID, true)
	got := sortedIDs(res.ParticipantIDs)
	want := []int64{fixtureMember, fixtureMember2}
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("audience after accept = %v, want %v", got, want)
	}
}

func TestSetMessagePinned_GroupDMReachesEveryMember(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	f.messages.SetMessageRequests(NewMessageRequestService(f.database, NewBlockService(f.database)))
	sent := mustSendMessage(ctx, t, f.messages, SendMessageParams{
		ChannelID: f.dm, UserID: fixtureMember, Username: "u3", Content: "hi",
	})
	res := mustPin(ctx, t, f.messages, "pin", fixtureMember2, f.dm, sent.MessageID, true)
	got := sortedIDs(res.ParticipantIDs)
	if want := f.members(t); !slices.Equal(got, want) {
		t.Errorf("group audience = %v, want every member %v", got, want)
	}
}

// A deleted pin row still holds its window, so a pin that follows its deletion
// inside the window writes no new row.
func TestSetMessagePinned_DeletedRowHoldsWindow(t *testing.T) {
	svc, _, database, msgID := pinFixture(t)
	ctx := context.Background()
	res := mustPin(ctx, t, svc, "pin", 2, 10, msgID, true)
	if _, err := svc.DeleteMessage(ctx, 2, res.Row.MessageID); err != nil {
		t.Fatalf("delete pin row: %v", err)
	}
	if _, err := svc.SetMessagePinned(ctx, 2, 10, msgID, false); err != nil {
		t.Fatalf("unpin: %v", err)
	}
	again, err := svc.SetMessagePinned(ctx, 2, 10, msgID, true)
	if err != nil || again != nil {
		t.Errorf("pin after deleting the row: res = %v, err = %v, want nil, nil", again, err)
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE kind = 7`).Scan(&n); err != nil || n != 1 {
		t.Errorf("pin rows = %d (err %v), want 1", n, err)
	}
}

func TestSetMessagePinned_RateLimited(t *testing.T) {
	svc, perms, database, msgID := pinFixture(t)
	limited := NewMessageService(database, perms, auth.NewRateLimiter())
	ctx := context.Background()
	var limitedErr error
	for i := range 20 {
		_, err := limited.SetMessagePinned(ctx, 2, 10, msgID, i%2 == 0)
		if err != nil {
			limitedErr = err
			break
		}
	}
	if !errors.Is(limitedErr, ErrRateLimited) {
		t.Errorf("20 rapid pin toggles: err = %v, want ErrRateLimited", limitedErr)
	}
	if _, err := svc.SetMessagePinned(ctx, 2, 10, msgID, true); err != nil {
		t.Errorf("a service without a limiter refused a pin: %v", err)
	}
}

// failingDMIDsStore fails the participant read DMAudience falls back to.
type failingDMIDsStore struct {
	*db.DB
}

func (s *failingDMIDsStore) GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error) {
	return nil, errors.New("simulated GetDMParticipantIDs failure")
}

// A DM pin row whose audience lookup fails goes to the pinner only, as edit and
// delete do, never to the channel-topic fallback.
func TestPinEventResult_AudienceLookupFailureFailsClosed(t *testing.T) {
	f := newModerationActionsFixture(t)
	svc := NewMessageService(&failingDMIDsStore{DB: f.database}, nil, nil)
	author := &db.User{ID: fixtureMember}
	res := svc.pinEventResult(context.Background(), &db.Channel{ID: 99, Type: "dm"}, &db.PinEventRow{}, author)
	if !res.IsDM || !slices.Equal(res.ParticipantIDs, []int64{fixtureMember}) {
		t.Errorf("IsDM = %v participants = %v, want a DM result for the pinner %d only", res.IsDM, res.ParticipantIDs, fixtureMember)
	}
}
