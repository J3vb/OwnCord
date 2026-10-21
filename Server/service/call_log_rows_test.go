package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// callRowFixture is a DM between two members that holds one call log row
// authored by fixtureMember. Only the server writes such a row, so the test
// writes it straight through the db layer.
func callRowFixture(t *testing.T) (f *moderationActionsFixture, dmID, callMsgID int64) {
	t.Helper()
	f = newModerationActionsFixture(t)
	ctx := context.Background()
	dm, err := NewDMService(f.database, f.mod.perms).CreateDM(ctx, fixtureMember, fixtureMember2)
	if err != nil {
		t.Fatalf("CreateDM: %v", err)
	}
	row, err := f.database.CreateCallLog(ctx, db.CallLogParams{
		ChannelID: dm.Channel.ID, AuthorID: fixtureMember, Content: "started a call.",
		StartedAt: "2026-10-16 10:00:00", LastSeenAt: "2026-10-16 10:00:00",
		ParticipantIDs: []int64{fixtureMember, fixtureMember2},
	})
	if err != nil {
		t.Fatalf("CreateCallLog: %v", err)
	}
	return f, dm.Channel.ID, row.Message.ID
}

func assertCallRowUnchanged(t *testing.T, f *moderationActionsFixture, msgID int64) {
	t.Helper()
	m, err := f.database.GetMessage(context.Background(), msgID)
	if err != nil || m == nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if m.Deleted || m.Pinned || m.EditedAt != nil || m.Content != "started a call." {
		t.Errorf("call row changed: %+v", m)
	}
	reactions, err := f.database.GetReactions(context.Background(), msgID)
	if err != nil || len(reactions) != 0 {
		t.Errorf("reactions = %v (%v), want none", reactions, err)
	}
}

func TestEditMessage_CallRowForbidden(t *testing.T) {
	f, _, msgID := callRowFixture(t)
	// The author gets the same refusal as anyone else.
	if _, err := f.messages.EditMessage(context.Background(), fixtureMember, msgID, "rewritten"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("author edit = %v, want ErrForbidden", err)
	}
	assertCallRowUnchanged(t, f, msgID)
}

func TestDeleteMessage_CallRowForbiddenForAuthor(t *testing.T) {
	f, _, msgID := callRowFixture(t)
	ctx := context.Background()
	if _, err := f.messages.DeleteMessage(ctx, fixtureMember, msgID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("author delete = %v, want ErrForbidden", err)
	}
	// Moderators and administrators are refused too.
	for _, who := range []int64{fixtureMod, fixtureOwner} {
		if _, err := f.messages.DeleteMessage(ctx, who, msgID); !errors.Is(err, ErrForbidden) {
			t.Errorf("delete by %d = %v, want ErrForbidden", who, err)
		}
	}
	if _, err := f.messages.DeleteMessageForReport(ctx, fixtureMod, msgID, 1, "r"); !errors.Is(err, ErrForbidden) {
		t.Errorf("report-linked delete = %v, want ErrForbidden", err)
	}
	assertCallRowUnchanged(t, f, msgID)
}

func TestReaction_CallRowRefused(t *testing.T) {
	f, _, msgID := callRowFixture(t)
	ctx := context.Background()
	if _, err := f.messages.AddReaction(ctx, fixtureMember2, msgID, "👍"); !errors.Is(err, ErrBadRequest) {
		t.Errorf("add = %v, want ErrBadRequest", err)
	}
	if _, err := f.messages.RemoveReaction(ctx, fixtureMember2, msgID, "👍"); !errors.Is(err, ErrBadRequest) {
		t.Errorf("remove = %v, want ErrBadRequest", err)
	}
	assertCallRowUnchanged(t, f, msgID)
}

func TestPin_CallRowRefused(t *testing.T) {
	f, dmID, msgID := callRowFixture(t)
	if _, err := f.messages.SetMessagePinned(context.Background(), fixtureMember, dmID, msgID, true); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("pin = %v, want ErrBadRequest", err)
	}
	assertCallRowUnchanged(t, f, msgID)
}

func TestSend_ReplyToCallRowRefused(t *testing.T) {
	f, dmID, msgID := callRowFixture(t)
	ctx := context.Background()
	_, err := f.messages.SendMessage(ctx, SendMessageParams{
		ChannelID: dmID, UserID: fixtureMember2, Username: "u5", Content: "answering", ReplyTo: &msgID,
	})
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("reply = %v, want ErrBadRequest", err)
	}
	// A reply to an ordinary message in the same DM still works.
	plain, err := f.messages.SendMessage(ctx, SendMessageParams{
		ChannelID: dmID, UserID: fixtureMember, Username: "u3", Content: "hi",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if _, err := f.messages.SendMessage(ctx, SendMessageParams{
		ChannelID: dmID, UserID: fixtureMember2, Username: "u5", Content: "hello", ReplyTo: &plain.MessageID,
	}); err != nil {
		t.Errorf("reply to an ordinary message: %v", err)
	}
}

// A non-member gets the same answer for a call row as for a missing id.
func TestReaction_CallRowNonMemberSameAsMissing(t *testing.T) {
	f, _, msgID := callRowFixture(t)
	ctx := context.Background()
	_, callErr := f.messages.AddReaction(ctx, fixtureOwner, msgID, "👍")
	_, missingErr := f.messages.AddReaction(ctx, fixtureOwner, 999999, "👍")
	if !errors.Is(callErr, ErrBadRequest) || !errors.Is(missingErr, ErrBadRequest) {
		t.Fatalf("call row err = %v, missing id err = %v, want both ErrBadRequest", callErr, missingErr)
	}
	if strings.Contains(callErr.Error(), "call") {
		t.Errorf("non-member learns the id is a call: %v", callErr)
	}
}
