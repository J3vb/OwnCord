package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

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
	sent, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", Content: "pin me",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
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
	if err := svc.SetMessagePinned(ctx, 2, 10, msgID, true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator with a user deny of MANAGE pinned: err = %v, want ErrForbidden", err)
	}

	if err := svc.SetMessagePinned(ctx, 1, 10, msgID, true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member without MANAGE pinned: err = %v, want ErrForbidden", err)
	}
	seedChannelUserOverride(t, database, 1, 10, permissions.ManageMessages, 0)
	permSvc.InvalidateChannel(10)
	if err := svc.SetMessagePinned(ctx, 1, 10, msgID, true); err != nil {
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
	dms := NewDMService(f.database, f.mod.perms)

	direct, err := dms.CreateDM(ctx, fixtureMember, fixtureMember2)
	if err != nil {
		t.Fatalf("CreateDM: %v", err)
	}
	dmSent, err := f.messages.SendMessage(ctx, SendMessageParams{
		ChannelID: direct.Channel.ID, UserID: fixtureMember2, Username: "u5", Content: "hi",
	})
	if err != nil {
		t.Fatalf("SendMessage dm: %v", err)
	}
	seedChannel(t, f.database, &db.Channel{ID: 900, Name: "pin-errors", Type: "text"})
	textSent, err := f.messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 900, UserID: fixtureMember, Username: "u3", Content: "hello",
	})
	if err != nil {
		t.Fatalf("SendMessage text: %v", err)
	}

	if err := f.messages.SetMessagePinned(ctx, fixtureOwner, direct.Channel.ID, dmSent.MessageID, true); !errors.Is(err, ErrNotFound) {
		t.Errorf("DM non-participant (even an administrator) = %v, want ErrNotFound", err)
	}
	if err := f.messages.SetMessagePinned(ctx, fixtureMember, 900, textSent.MessageID, true); !errors.Is(err, ErrForbidden) {
		t.Errorf("text channel without MANAGE = %v, want ErrForbidden", err)
	}

	seedBlock(t, f.database, fixtureMember2, fixtureMember)
	if err := f.messages.SetMessagePinned(ctx, fixtureMember, direct.Channel.ID, dmSent.MessageID, true); !errors.Is(err, ErrBlocked) {
		t.Errorf("DM pin while blocked = %v, want ErrBlocked", err)
	}
	if _, err := f.database.ExecContext(ctx, `DELETE FROM user_blocks`); err != nil {
		t.Fatalf("clear blocks: %v", err)
	}

	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	if err := f.messages.SetMessagePinned(ctx, fixtureMember, direct.Channel.ID, dmSent.MessageID, true); !errors.Is(err, ErrTimedOut) {
		t.Errorf("DM pin while timed out = %v, want ErrTimedOut", err)
	}
}
