package service

import (
	"context"
	"testing"
)

// Both unread queries — GetChannelUnreadCounts (text channels) and
// GetUserDMChannels (DMs) — count "messages with id greater than my
// read_states row" and neither filters by author. Nothing else advanced the
// sender's read state, so an author's own message counted as unread to
// themselves: post, navigate away, and the next `ready` restated it as an
// unread badge that never cleared until something else marked the channel
// read. SendMessage now advances the author's read state past the message it
// just committed.
func TestSendMessage_AdvancesAuthorReadState(t *testing.T) {
	ctx := context.Background()
	svc, _, database := newMentionFixture(t)

	const author = int64(1)
	const other = int64(2)

	res := sendAs(t, svc, author, "my own message")

	counts, err := database.GetChannelUnreadCounts(ctx, author)
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts(author): %v", err)
	}
	if got := counts[10].UnreadCount; got != 0 {
		t.Fatalf("author unread = %d, want 0 — your own message must not read back as unread to you", got)
	}

	// The read state must land exactly on the sent message, not merely be
	// non-zero: a value past it would swallow a later message from someone
	// else, which is a worse bug than the one being fixed.
	if got := counts[10].LastMessageID; got != res.MessageID {
		t.Fatalf("author last_msg_id = %d, want %d", got, res.MessageID)
	}

	// Everyone else must still see it as unread — this fix must not suppress
	// the badge for the recipients it exists for.
	otherCounts, err := database.GetChannelUnreadCounts(ctx, other)
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts(other): %v", err)
	}
	if got := otherCounts[10].UnreadCount; got != 1 {
		t.Fatalf("recipient unread = %d, want 1 — a message from someone else is still unread", got)
	}
}

// A message that arrives AFTER the author's own send must still register as
// unread for the author: advancing the read state on send must move it to the
// sent message, never past it.
func TestSendMessage_AuthorStillSeesLaterMessagesAsUnread(t *testing.T) {
	ctx := context.Background()
	svc, _, database := newMentionFixture(t)

	const author = int64(1)
	const other = int64(2)

	sendAs(t, svc, author, "mine")
	sendAs(t, svc, other, "theirs")

	counts, err := database.GetChannelUnreadCounts(ctx, author)
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts: %v", err)
	}
	if got := counts[10].UnreadCount; got != 1 {
		t.Fatalf("author unread = %d, want 1 (only the reply from the other user)", got)
	}
}
