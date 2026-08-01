package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// seedReactedMessage posts a message in channel 10 and has each of userIDs
// react to it with emoji, returning the message id.
func seedReactedMessage(t *testing.T, svc *MessageService, database *db.DB, emoji string, userIDs ...int64) int64 {
	t.Helper()
	msgID, err := database.CreateMessage(context.Background(), 10, 1, "react to me", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	for _, uid := range userIDs {
		if _, err := svc.AddReaction(context.Background(), uid, msgID, emoji); err != nil {
			t.Fatalf("AddReaction(%d): %v", uid, err)
		}
	}
	return msgID
}

func TestGetReactionUsers_ReturnsReactors(t *testing.T) {
	svc, database := newTestMessageService(t)
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	msgID := seedReactedMessage(t, svc, database, "👍", 1, 2)

	users, err := svc.GetReactionUsers(context.Background(), 1, 10, msgID, "👍")
	if err != nil {
		t.Fatalf("GetReactionUsers: %v", err)
	}
	if len(users) != 2 {
		t.Fatalf("len(users) = %d, want 2 (%+v)", len(users), users)
	}
	if users[0].Username != "alice" || users[1].Username != "bob" {
		t.Errorf("usernames = [%s %s], want [alice bob]", users[0].Username, users[1].Username)
	}
}

// An emoji nobody used is an empty list, never nil — the handler serialises it
// straight to JSON and `null` is not a list the client can iterate.
func TestGetReactionUsers_EmptyIsNonNil(t *testing.T) {
	svc, database := newTestMessageService(t)
	msgID := seedReactedMessage(t, svc, database, "👍", 1)

	users, err := svc.GetReactionUsers(context.Background(), 1, 10, msgID, "🎉")
	if err != nil {
		t.Fatalf("GetReactionUsers: %v", err)
	}
	if users == nil {
		t.Fatal("users = nil, want an empty slice")
	}
	if len(users) != 0 {
		t.Errorf("len(users) = %d, want 0", len(users))
	}
}

// Reading the reactor list is gated by the same READ_MESSAGES check as reading
// the channel's history: a reaction pill must not leak who is in a channel the
// caller cannot see.
func TestGetReactionUsers_ForbiddenWithoutReadPermission(t *testing.T) {
	svc, database := newTestMessageService(t)
	msgID := seedReactedMessage(t, svc, database, "👍", 1)

	seedRole(t, database, &db.Role{ID: 90, Name: "outsider", Permissions: 0, Position: 1})
	seedUser(t, database, &db.User{ID: 3, Username: "outsider"})
	seedUserRole(t, database, 3, 90)

	_, err := svc.GetReactionUsers(context.Background(), 3, 10, msgID, "👍")
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
}

// The channel in the URL is what the permission check ran against, so a message
// that lives elsewhere must not be answered from that check.
func TestGetReactionUsers_MessageInAnotherChannelIsNotFound(t *testing.T) {
	svc, database := newTestMessageService(t)
	seedChannel(t, database, &db.Channel{ID: 11, Name: "other", Type: "text"})
	msgID := seedReactedMessage(t, svc, database, "👍", 1)

	_, err := svc.GetReactionUsers(context.Background(), 1, 11, msgID, "👍")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestGetReactionUsers_RejectsBadInput(t *testing.T) {
	svc, database := newTestMessageService(t)
	msgID := seedReactedMessage(t, svc, database, "👍", 1)

	tests := []struct {
		name    string
		msgID   int64
		emoji   string
		wantErr error
	}{
		{"zero message id", 0, "👍", ErrBadRequest},
		{"negative message id", -5, "👍", ErrBadRequest},
		{"empty emoji", msgID, "", ErrBadRequest},
		{"overlong emoji", msgID, strings.Repeat("a", 33), ErrBadRequest},
		{"control character", msgID, "a\x01b", ErrBadRequest},
		{"unknown message", 999999, "👍", ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := svc.GetReactionUsers(context.Background(), 1, 10, tt.msgID, tt.emoji)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
		})
	}
}

// A DM the caller is not a participant of is reported as not-found (matching
// requireChannelRead), so its existence stays hidden.
func TestGetReactionUsers_ForeignDMIsNotFound(t *testing.T) {
	svc, database := newTestMessageService(t)
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUser(t, database, &db.User{ID: 3, Username: "carol"})
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedUserRole(t, database, 3, permissions.MemberRoleID)

	ch, _, err := database.GetOrCreateDMChannel(context.Background(), 2, 3)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	msgID, err := database.CreateMessage(context.Background(), ch.ID, 2, "psst", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if _, err := svc.AddReaction(context.Background(), 3, msgID, "👍"); err != nil {
		t.Fatalf("AddReaction: %v", err)
	}

	if _, err := svc.GetReactionUsers(context.Background(), 1, ch.ID, msgID, "👍"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	// A participant does get the list.
	users, err := svc.GetReactionUsers(context.Background(), 2, ch.ID, msgID, "👍")
	if err != nil {
		t.Fatalf("GetReactionUsers(participant): %v", err)
	}
	if len(users) != 1 || users[0].Username != "carol" {
		t.Errorf("users = %+v, want [carol]", users)
	}
}
