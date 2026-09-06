package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// seedMessageRequestPair creates two users, a one-to-one DM channel between
// them, and a first message in it — CreateMessageRequest's first_message_id
// (Codex P1-4/P2-6) has a NOT-nullable FK to messages(id), so every request
// needs a real row to name. No trust row exists for either direction.
func seedMessageRequestPair(t *testing.T, database *db.DB, senderName, recipientName string) (senderID, recipientID, channelID, messageID int64) {
	t.Helper()
	senderID = seedUser(t, database, senderName)
	recipientID = seedUser(t, database, recipientName)
	ch, _, err := database.GetOrCreateDMChannel(context.Background(), senderID, recipientID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	messageID, err = database.CreateMessage(context.Background(), ch.ID, senderID, "hi", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	return senderID, recipientID, ch.ID, messageID
}

func TestIsTrustedSender_TrustSender(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sender, recipient, _, _ := seedMessageRequestPair(t, database, "mrq-trust-sender", "mrq-trust-recipient")

	if trusted, err := database.IsTrustedSender(ctx, recipient, sender); err != nil || trusted {
		t.Fatalf("IsTrustedSender before any trust row = %v, %v; want false, nil", trusted, err)
	}
	if err := database.TrustSender(ctx, recipient, sender, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}
	if trusted, err := database.IsTrustedSender(ctx, recipient, sender); err != nil || !trusted {
		t.Fatalf("IsTrustedSender after TrustSender = %v, %v; want true, nil", trusted, err)
	}
	// The reverse direction is untouched.
	if trusted, err := database.IsTrustedSender(ctx, sender, recipient); err != nil || trusted {
		t.Fatalf("IsTrustedSender(reverse) = %v, %v; want false, nil", trusted, err)
	}
	// INSERT OR IGNORE: a second call with a different source does not
	// overwrite the first.
	if err := database.TrustSender(ctx, recipient, sender, "sent_first"); err != nil {
		t.Fatalf("TrustSender (repeat): %v", err)
	}
	var source string
	if err := database.QueryRowContext(ctx, `SELECT source FROM trusted_senders WHERE recipient_id = ? AND sender_id = ?`,
		recipient, sender).Scan(&source); err != nil || source != "accepted" {
		t.Errorf("source after a repeat TrustSender = %q, %v; want unchanged \"accepted\"", source, err)
	}
}

func TestCreateMessageRequest_OneRowPerPairEver(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sender, recipient, channelID, msgID := seedMessageRequestPair(t, database, "mrq-create-sender", "mrq-create-recipient")

	created, err := database.CreateMessageRequest(ctx, sender, recipient, channelID, msgID)
	if err != nil || !created {
		t.Fatalf("first CreateMessageRequest = %v, %v; want true, nil", created, err)
	}
	created, err = database.CreateMessageRequest(ctx, sender, recipient, channelID, msgID)
	if err != nil || created {
		t.Fatalf("second CreateMessageRequest = %v, %v; want false, nil (one row per pair, ever)", created, err)
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM message_requests`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("message_requests rows = %d, %v; want 1", n, err)
	}

	// A different pair is a different row.
	third := seedUser(t, database, "mrq-create-third")
	otherCh, _, err := database.GetOrCreateDMChannel(ctx, sender, third)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	otherMsgID, err := database.CreateMessage(ctx, otherCh.ID, sender, "hi", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	created, err = database.CreateMessageRequest(ctx, sender, third, otherCh.ID, otherMsgID)
	if err != nil || !created {
		t.Fatalf("CreateMessageRequest for a different pair = %v, %v; want true, nil", created, err)
	}
}

// TestCreateMessageRequest_AlsoWritesSentFirstTrustAtomically is Codex
// P2-6: the request insert and the sent_first trust write happen in the
// same transaction, so a caller that observes created=true has also always
// already committed the trust row — there is no window where one exists
// without the other.
func TestCreateMessageRequest_AlsoWritesSentFirstTrustAtomically(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sender, recipient, channelID, msgID := seedMessageRequestPair(t, database, "mrq-atomic-sender", "mrq-atomic-recipient")

	created, err := database.CreateMessageRequest(ctx, sender, recipient, channelID, msgID)
	if err != nil || !created {
		t.Fatalf("CreateMessageRequest = %v, %v; want true, nil", created, err)
	}
	if n := countRowsMR(t, database, `SELECT COUNT(*) FROM message_requests WHERE sender_id = ? AND recipient_id = ?`, sender, recipient); n != 1 {
		t.Errorf("message_requests rows = %d, want 1", n)
	}
	// trusted_senders(recipient=sender, sender=recipient, "sent_first"): the
	// original sender initiated, so trusts the recipient's eventual reply.
	if trusted, err := database.IsTrustedSender(ctx, sender, recipient); err != nil || !trusted {
		t.Errorf("IsTrustedSender(sender, recipient) after CreateMessageRequest = %v, %v; want true, nil", trusted, err)
	}
	var source string
	if err := database.QueryRowContext(ctx, `SELECT source FROM trusted_senders WHERE recipient_id = ? AND sender_id = ?`,
		sender, recipient).Scan(&source); err != nil || source != "sent_first" {
		t.Errorf("trust source = %q, %v; want \"sent_first\"", source, err)
	}
}

func TestGetMessageRequest_ScopedToRecipient(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sender, recipient, channelID, msgID := seedMessageRequestPair(t, database, "mrq-get-sender", "mrq-get-recipient")
	if _, err := database.CreateMessageRequest(ctx, sender, recipient, channelID, msgID); err != nil {
		t.Fatalf("CreateMessageRequest: %v", err)
	}
	byPair, err := database.GetMessageRequestByPair(ctx, sender, recipient)
	if err != nil {
		t.Fatalf("GetMessageRequestByPair: %v", err)
	}
	if byPair.SenderID != sender || byPair.RecipientID != recipient || byPair.State != "pending" {
		t.Errorf("GetMessageRequestByPair = %+v", byPair)
	}

	got, err := database.GetMessageRequest(ctx, byPair.ID, recipient)
	if err != nil {
		t.Fatalf("GetMessageRequest(correct recipient): %v", err)
	}
	if got.ID != byPair.ID {
		t.Errorf("GetMessageRequest id = %d, want %d", got.ID, byPair.ID)
	}

	if _, err := database.GetMessageRequest(ctx, byPair.ID, sender); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("GetMessageRequest(sender instead of recipient) = %v, want ErrNotFound", err)
	}
	third := seedUser(t, database, "mrq-get-third")
	if _, err := database.GetMessageRequest(ctx, byPair.ID, third); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("GetMessageRequest(unrelated user) = %v, want ErrNotFound", err)
	}
	if _, err := database.GetMessageRequestByPair(ctx, sender, third); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("GetMessageRequestByPair(no such pair) = %v, want ErrNotFound", err)
	}
}

func TestListPendingMessageRequests_JoinsSenderAndPreview(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sender, recipient, channelID, _ := seedMessageRequestPair(t, database, "mrq-list-sender", "mrq-list-recipient")
	msgID, err := database.CreateMessage(ctx, channelID, sender, "hello there", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if _, err := database.CreateMessageRequest(ctx, sender, recipient, channelID, msgID); err != nil {
		t.Fatalf("CreateMessageRequest: %v", err)
	}

	views, err := database.ListPendingMessageRequests(ctx, recipient)
	if err != nil {
		t.Fatalf("ListPendingMessageRequests: %v", err)
	}
	if len(views) != 1 {
		t.Fatalf("views = %d, want 1", len(views))
	}
	v := views[0]
	if v.SenderUsername != "mrq-list-sender" || v.ChannelID != channelID || v.State != "pending" {
		t.Errorf("view = %+v", v)
	}
	if v.PreviewMessageID != msgID || v.PreviewContent != "hello there" {
		t.Errorf("view preview = message_id=%d content=%q, want %d, %q", v.PreviewMessageID, v.PreviewContent, msgID, "hello there")
	}

	// A non-pending state (e.g. accepted) drops out of the pending listing.
	if _, err := database.TransitionMessageRequest(ctx, v.ID, recipient, "ignored"); err != nil {
		t.Fatalf("TransitionMessageRequest: %v", err)
	}
	views, err = database.ListPendingMessageRequests(ctx, recipient)
	if err != nil {
		t.Fatalf("ListPendingMessageRequests (after ignore): %v", err)
	}
	if len(views) != 0 {
		t.Errorf("views after ignore = %d, want 0", len(views))
	}

	// A recipient with nothing pending gets an empty (not nil) slice from the
	// service layer; the DB layer itself is free to return nil, which the
	// caller normalises — assert only that it does not error.
	if _, err := database.ListPendingMessageRequests(ctx, sender); err != nil {
		t.Errorf("ListPendingMessageRequests(sender, nothing pending): %v", err)
	}
}

// TestListPendingMessageRequests_DeletedOriginalHasNoPreview is Codex P1-4:
// a request whose held message has since been soft-deleted (deleted = 1,
// content untouched — DeleteMessage never clears it) must report no preview
// at all, never the deleted content.
func TestListPendingMessageRequests_DeletedOriginalHasNoPreview(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sender, recipient, channelID, msgID := seedMessageRequestPair(t, database, "mrq-delpreview-sender", "mrq-delpreview-recipient")
	if _, err := database.CreateMessageRequest(ctx, sender, recipient, channelID, msgID); err != nil {
		t.Fatalf("CreateMessageRequest: %v", err)
	}

	if err := database.DeleteMessage(ctx, msgID, sender, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}
	// The row's content survives soft delete — this is what would leak
	// without the query's own deleted = 0 filter.
	var content string
	if err := database.QueryRowContext(ctx, `SELECT content FROM messages WHERE id = ?`, msgID).Scan(&content); err != nil || content == "" {
		t.Fatalf("sanity: deleted message content = %q, %v; want the original text still there", content, err)
	}

	views, err := database.ListPendingMessageRequests(ctx, recipient)
	if err != nil {
		t.Fatalf("ListPendingMessageRequests: %v", err)
	}
	if len(views) != 1 {
		t.Fatalf("views = %d, want 1 (the request itself is unaffected by the message's deletion)", len(views))
	}
	v := views[0]
	if v.PreviewMessageID != 0 || v.PreviewContent != "" || v.PreviewTimestamp != "" {
		t.Errorf("preview for a deleted original = %+v, want all empty (no preview)", v)
	}
}

func TestTransitionMessageRequest_GuardedUpdate(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sender, recipient, channelID, msgID := seedMessageRequestPair(t, database, "mrq-transition-sender", "mrq-transition-recipient")
	if _, err := database.CreateMessageRequest(ctx, sender, recipient, channelID, msgID); err != nil {
		t.Fatalf("CreateMessageRequest: %v", err)
	}
	req, err := database.GetMessageRequestByPair(ctx, sender, recipient)
	if err != nil {
		t.Fatalf("GetMessageRequestByPair: %v", err)
	}

	ok, err := database.TransitionMessageRequest(ctx, req.ID, recipient, "ignored")
	if err != nil || !ok {
		t.Fatalf("first transition = %v, %v; want true, nil", ok, err)
	}
	updated, err := database.GetMessageRequest(ctx, req.ID, recipient)
	if err != nil || updated.State != "ignored" || updated.DecidedAt == nil {
		t.Fatalf("after transition: %+v, %v", updated, err)
	}

	// No longer pending: the guarded UPDATE matches nothing.
	ok, err = database.TransitionMessageRequest(ctx, req.ID, recipient, "deleted")
	if err != nil || ok {
		t.Fatalf("transition on an already-decided row = %v, %v; want false, nil", ok, err)
	}
	// Wrong recipient: the guarded UPDATE matches nothing either.
	sender2, recipient2, channelID2, msgID2 := seedMessageRequestPair(t, database, "mrq-transition-sender2", "mrq-transition-recipient2")
	if _, err := database.CreateMessageRequest(ctx, sender2, recipient2, channelID2, msgID2); err != nil {
		t.Fatalf("CreateMessageRequest: %v", err)
	}
	req2, err := database.GetMessageRequestByPair(ctx, sender2, recipient2)
	if err != nil {
		t.Fatalf("GetMessageRequestByPair: %v", err)
	}
	ok, err = database.TransitionMessageRequest(ctx, req2.ID, sender2, "ignored")
	if err != nil || ok {
		t.Fatalf("transition by the sender instead of the recipient = %v, %v; want false, nil", ok, err)
	}
}

// TestMessageRequest_ErasingEitherPartyRemovesRequestAndTrust is the
// class's own retention/deletion integration test (community-services.md
// S1's lifecycle table): erasing EITHER the sender or the recipient must
// remove the message_requests row and every trusted_senders row naming
// them, in both directions.
func TestMessageRequest_ErasingEitherPartyRemovesRequestAndTrust(t *testing.T) {
	for _, eraseWho := range []string{"sender", "recipient"} {
		t.Run(eraseWho, func(t *testing.T) {
			database := openMigratedMemory(t)
			ctx := context.Background()
			sender, recipient, channelID, msgID := seedMessageRequestPair(t, database, "mrq-erase-sender-"+eraseWho, "mrq-erase-recipient-"+eraseWho)
			if _, err := database.CreateMessageRequest(ctx, sender, recipient, channelID, msgID); err != nil {
				t.Fatalf("CreateMessageRequest: %v", err)
			}
			if err := database.TrustSender(ctx, sender, recipient, "sent_first"); err != nil {
				t.Fatalf("TrustSender: %v", err)
			}

			target := sender
			if eraseWho == "recipient" {
				target = recipient
			}
			if _, err := database.EraseAccount(ctx, target, ""); err != nil {
				t.Fatalf("EraseAccount(%s): %v", eraseWho, err)
			}

			if n := countRowsMR(t, database, `SELECT COUNT(*) FROM message_requests`); n != 0 {
				t.Errorf("message_requests rows after erasing the %s = %d, want 0", eraseWho, n)
			}
			if n := countRowsMR(t, database, `SELECT COUNT(*) FROM trusted_senders`); n != 0 {
				t.Errorf("trusted_senders rows after erasing the %s = %d, want 0", eraseWho, n)
			}
		})
	}
}

func countRowsMR(t *testing.T, database *db.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

func TestAcceptMessageRequest(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sender, recipient, channelID, msgID := seedMessageRequestPair(t, database, "mrq-accept-sender", "mrq-accept-recipient")
	if _, err := database.CreateMessageRequest(ctx, sender, recipient, channelID, msgID); err != nil {
		t.Fatalf("CreateMessageRequest: %v", err)
	}
	req, err := database.GetMessageRequestByPair(ctx, sender, recipient)
	if err != nil {
		t.Fatalf("GetMessageRequestByPair: %v", err)
	}

	updated, err := database.AcceptMessageRequest(ctx, req.ID, recipient)
	if err != nil {
		t.Fatalf("AcceptMessageRequest: %v", err)
	}
	if updated.State != "accepted" || updated.DecidedAt == nil {
		t.Errorf("updated = %+v", updated)
	}
	if trusted, err := database.IsTrustedSender(ctx, recipient, sender); err != nil || !trusted {
		t.Errorf("IsTrustedSender(recipient, sender) after accept = %v, %v; want true, nil", trusted, err)
	}
	var opened int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM dm_open_state WHERE user_id = ? AND channel_id = ?`,
		recipient, channelID).Scan(&opened); err != nil || opened != 1 {
		t.Errorf("dm_open_state rows = %d, %v; want 1 (accept opened the channel)", opened, err)
	}

	// Not pending any more: the second accept is ErrConflict.
	if _, err := database.AcceptMessageRequest(ctx, req.ID, recipient); !errors.Is(err, db.ErrConflict) {
		t.Errorf("second AcceptMessageRequest = %v, want ErrConflict", err)
	}
	// Unknown id: ErrNotFound.
	if _, err := database.AcceptMessageRequest(ctx, req.ID+1000, recipient); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("AcceptMessageRequest(unknown id) = %v, want ErrNotFound", err)
	}
	// Wrong recipient: ErrNotFound, not ErrConflict — the row is not theirs.
	sender2, recipient2, channelID2, msgID2 := seedMessageRequestPair(t, database, "mrq-accept-sender2", "mrq-accept-recipient2")
	if _, err := database.CreateMessageRequest(ctx, sender2, recipient2, channelID2, msgID2); err != nil {
		t.Fatalf("CreateMessageRequest: %v", err)
	}
	req2, err := database.GetMessageRequestByPair(ctx, sender2, recipient2)
	if err != nil {
		t.Fatalf("GetMessageRequestByPair: %v", err)
	}
	if _, err := database.AcceptMessageRequest(ctx, req2.ID, sender2); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("AcceptMessageRequest(by the sender) = %v, want ErrNotFound", err)
	}
}
