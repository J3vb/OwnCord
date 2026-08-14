package service

import (
	"context"
	"errors"
	"testing"

	"github.com/owncord/server/db"
)

// `archived` used to be consulted only by the visibility predicate
// (VisibleChannelIDs / RefreshChannelVisibility), so it hid a channel without
// protecting it: any caller still holding the id — a custom client, or a stock
// client racing the channel_delete that archiving triggers — could keep posting
// into an archive indefinitely, with nobody able to see or moderate the result.
// Archived channels are now read-only.
func TestSendMessage_RefusedInArchivedChannel(t *testing.T) {
	ctx := context.Background()
	svc, _, database := newMentionFixture(t)

	if _, err := database.ExecContext(ctx,
		`UPDATE channels SET archived = 1 WHERE id = 10`); err != nil {
		t.Fatalf("archive channel: %v", err)
	}

	_, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 10,
		UserID:    1,
		Username:  "alice",
		RoleName:  "member",
		Content:   "posting into the archive",
	})
	if err == nil {
		t.Fatal("SendMessage into an archived channel succeeded — the archive is still writable")
	}
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("SendMessage error = %v, want ErrForbidden", err)
	}
}

// The gate must be scoped to the archive flag alone: un-archiving restores
// posting, and an ordinary channel is unaffected.
func TestSendMessage_AllowedAfterUnarchive(t *testing.T) {
	ctx := context.Background()
	svc, _, database := newMentionFixture(t)

	if _, err := database.ExecContext(ctx,
		`UPDATE channels SET archived = 1 WHERE id = 10`); err != nil {
		t.Fatalf("archive channel: %v", err)
	}
	if _, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", RoleName: "member", Content: "blocked",
	}); err == nil {
		t.Fatal("precondition: send should be refused while archived")
	}

	if _, err := database.ExecContext(ctx,
		`UPDATE channels SET archived = 0 WHERE id = 10`); err != nil {
		t.Fatalf("unarchive channel: %v", err)
	}

	if _, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", RoleName: "member", Content: "allowed again",
	}); err != nil {
		t.Fatalf("SendMessage after unarchive: %v", err)
	}
}

// OC-0022: SendMessage's archived gate lived only on SendMessage. EditMessage
// routed its non-DM permission check through checkSendPermission, which
// carried no archived check at all, so an author who still held a message id
// could keep injecting arbitrary new text into an archived channel — fanned
// out to every reader as chat_edited — even though a fresh chat_send was
// refused. The gate must be shared, not re-implemented per sink.
func TestEditMessage_RefusedInArchivedChannel(t *testing.T) {
	svc, database := newTestMessageService(t)
	ctx := context.Background()

	sent, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", RoleName: "member", Content: "original",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	if _, err := database.ExecContext(ctx,
		`UPDATE channels SET archived = 1 WHERE id = 10`); err != nil {
		t.Fatalf("archive channel: %v", err)
	}

	if _, err := svc.EditMessage(ctx, 1, sent.MessageID, "slipped past the archive"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("EditMessage in an archived channel: err = %v, want ErrForbidden", err)
	}

	msg, err := database.GetMessage(ctx, sent.MessageID)
	if err != nil || msg == nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if msg.Content != "original" {
		t.Fatalf("content must survive a refused edit against an archived channel, got %q", msg.Content)
	}
}

// OC-0022: handleReaction (AddReaction/RemoveReaction) bypasses
// checkSendPermission entirely, so it needs its own archived gate. A reaction
// fans a live reaction_update out to every reader just like a send or edit.
func TestAddReaction_RefusedInArchivedChannel(t *testing.T) {
	svc, database := newTestMessageService(t)
	ctx := context.Background()

	sent, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", RoleName: "member", Content: "react to me",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	if _, err := database.ExecContext(ctx,
		`UPDATE channels SET archived = 1 WHERE id = 10`); err != nil {
		t.Fatalf("archive channel: %v", err)
	}

	if _, err := svc.AddReaction(ctx, 1, sent.MessageID, "👍"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("AddReaction in an archived channel: err = %v, want ErrForbidden", err)
	}

	reactors, err := database.GetReactionUsers(ctx, sent.MessageID, "👍", db.MaxReactionUsers)
	if err != nil {
		t.Fatalf("GetReactionUsers: %v", err)
	}
	if len(reactors) != 0 {
		t.Fatalf("reaction must not persist against an archived channel, got %d reactors", len(reactors))
	}
}

// OC-0022: SetMessagePinned also bypasses checkSendPermission, so a
// MANAGE_MESSAGES holder could still pin/unpin in an archived channel.
func TestSetMessagePinned_RefusedInArchivedChannel(t *testing.T) {
	svc, database := newPurgeService(t) // seeds user 2 with MANAGE_MESSAGES on channel 10
	ctx := context.Background()

	sent, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", RoleName: "member", Content: "pin me",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	if _, err := database.ExecContext(ctx,
		`UPDATE channels SET archived = 1 WHERE id = 10`); err != nil {
		t.Fatalf("archive channel: %v", err)
	}

	if err := svc.SetMessagePinned(ctx, 2, 10, sent.MessageID, true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("SetMessagePinned in an archived channel: err = %v, want ErrForbidden", err)
	}

	pinned, err := database.GetPinnedMessages(ctx, 10, 2)
	if err != nil {
		t.Fatalf("GetPinnedMessages: %v", err)
	}
	if len(pinned) != 0 {
		t.Fatalf("pin must not persist against an archived channel, got %d pinned", len(pinned))
	}
}

// OC-0022: PurgeMessages also bypasses checkSendPermission, so a
// MANAGE_MESSAGES holder could still bulk-delete an archived channel's
// history.
func TestPurgeMessages_RefusedInArchivedChannel(t *testing.T) {
	svc, database := newPurgeService(t)
	ctx := context.Background()
	ids := seedPurgeMessages(t, database, 10, 3)

	if _, err := database.ExecContext(ctx,
		`UPDATE channels SET archived = 1 WHERE id = 10`); err != nil {
		t.Fatalf("archive channel: %v", err)
	}

	if _, err := svc.PurgeMessages(ctx, 2, 10, 3, 0); !errors.Is(err, ErrForbidden) {
		t.Fatalf("PurgeMessages against an archived channel: err = %v, want ErrForbidden", err)
	}

	for _, id := range ids {
		msg, err := database.GetMessage(ctx, id)
		if err != nil || msg == nil {
			t.Fatalf("GetMessage(%d): %v", id, err)
		}
		if msg.Deleted {
			t.Fatalf("message %d must survive a purge attempt against an archived channel", id)
		}
	}
}
