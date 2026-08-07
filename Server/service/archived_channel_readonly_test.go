package service

import (
	"context"
	"errors"
	"testing"
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
