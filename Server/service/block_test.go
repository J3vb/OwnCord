package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// BlockService had no coverage at all. Its job is the validation layer above
// db.BlockUser — which is INSERT OR IGNORE and therefore silently accepts a
// self-block — so these tests concentrate on the rejections.

func newBlockService(t *testing.T) (*BlockService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	return NewBlockService(database), database
}

func TestBlockService_BlockUser(t *testing.T) {
	svc, database := newBlockService(t)
	ctx := context.Background()

	if err := svc.BlockUser(ctx, 1, 2); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	blocked, err := database.IsBlocked(ctx, 1, 2)
	if err != nil {
		t.Fatalf("IsBlocked: %v", err)
	}
	if !blocked {
		t.Error("block was not persisted")
	}
}

func TestBlockService_BlockUser_Rejections(t *testing.T) {
	tests := []struct {
		name      string
		blockerID int64
		targetID  int64
		wantErr   error
	}{
		{"zero target", 1, 0, ErrBadRequest},
		{"negative target", 1, -5, ErrBadRequest},
		{"self block", 1, 1, ErrBadRequest},
		{"unknown target", 1, 9999, ErrNotFound},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc, database := newBlockService(t)
			ctx := context.Background()

			err := svc.BlockUser(ctx, tt.blockerID, tt.targetID)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("BlockUser(%d, %d) = %v, want %v",
					tt.blockerID, tt.targetID, err, tt.wantErr)
			}

			// A rejected block must not write anything.
			ids, listErr := database.ListBlockedUsers(ctx, tt.blockerID)
			if listErr != nil {
				t.Fatalf("ListBlockedUsers: %v", listErr)
			}
			if len(ids) != 0 {
				t.Errorf("a rejected block still wrote %v", ids)
			}
		})
	}
}

func TestBlockService_BlockUser_Idempotent(t *testing.T) {
	svc, database := newBlockService(t)
	ctx := context.Background()

	for i := range 2 {
		if err := svc.BlockUser(ctx, 1, 2); err != nil {
			t.Fatalf("BlockUser call %d: %v", i+1, err)
		}
	}

	ids, err := database.ListBlockedUsers(ctx, 1)
	if err != nil {
		t.Fatalf("ListBlockedUsers: %v", err)
	}
	if len(ids) != 1 {
		t.Errorf("ListBlockedUsers = %v after blocking twice, want one entry", ids)
	}
}

func TestBlockService_UnblockUser(t *testing.T) {
	svc, database := newBlockService(t)
	ctx := context.Background()

	if err := svc.BlockUser(ctx, 1, 2); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	if err := svc.UnblockUser(ctx, 1, 2); err != nil {
		t.Fatalf("UnblockUser: %v", err)
	}

	blocked, err := database.IsBlocked(ctx, 1, 2)
	if err != nil {
		t.Fatalf("IsBlocked: %v", err)
	}
	if blocked {
		t.Error("block survived UnblockUser")
	}
}

func TestBlockService_UnblockUser_Rejections(t *testing.T) {
	svc, _ := newBlockService(t)
	ctx := context.Background()

	for _, targetID := range []int64{0, -1} {
		if err := svc.UnblockUser(ctx, 1, targetID); !errors.Is(err, ErrBadRequest) {
			t.Errorf("UnblockUser(1, %d) = %v, want ErrBadRequest", targetID, err)
		}
	}

	// Unlike BlockUser, UnblockUser does not verify the target exists — an
	// unblock of a never-blocked (or deleted) user is a successful no-op.
	if err := svc.UnblockUser(ctx, 1, 9999); err != nil {
		t.Errorf("UnblockUser on an unknown user = %v, want nil (no-op)", err)
	}
}

func TestBlockService_ListBlocked(t *testing.T) {
	svc, database := newBlockService(t)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 3, Username: "carol"})

	// Never nil — the REST layer serializes this straight to JSON, and a nil
	// slice would emit `null` where clients expect `[]`.
	got, err := svc.ListBlocked(ctx, 1)
	if err != nil {
		t.Fatalf("ListBlocked: %v", err)
	}
	if got == nil {
		t.Fatal("ListBlocked returned nil; want an empty slice so it marshals as []")
	}
	if len(got) != 0 {
		t.Errorf("ListBlocked = %v on a fresh user, want empty", got)
	}

	if err := svc.BlockUser(ctx, 1, 2); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	if err := svc.BlockUser(ctx, 1, 3); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	got, err = svc.ListBlocked(ctx, 1)
	if err != nil {
		t.Fatalf("ListBlocked: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("ListBlocked = %v, want 2 entries", got)
	}

	// Another user's blocks must not appear.
	other, err := svc.ListBlocked(ctx, 2)
	if err != nil {
		t.Fatalf("ListBlocked for user 2: %v", err)
	}
	if len(other) != 0 {
		t.Errorf("ListBlocked(2) = %v, want empty", other)
	}
}

// Blocking revokes the blocker's trust in the target, so after an unblock the
// target's next message is a request again rather than silently delivered. The
// target's own trust in the blocker is left alone.
func TestBlockUser_RevokesBlockersTrustInTarget(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	ctx := context.Background()
	if err := database.TrustSender(ctx, 2, 1, "accepted"); err != nil {
		t.Fatalf("TrustSender(2,1): %v", err)
	}
	if err := database.TrustSender(ctx, 1, 2, "accepted"); err != nil {
		t.Fatalf("TrustSender(1,2): %v", err)
	}

	if err := svc.Blocks.BlockUser(ctx, 2, 1); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	if err := svc.Blocks.UnblockUser(ctx, 2, 1); err != nil {
		t.Fatalf("UnblockUser: %v", err)
	}

	if ok, _ := database.IsTrustedSender(ctx, 2, 1); ok {
		t.Error("blocker still trusts the blocked user after block + unblock")
	}
	if ok, _ := database.IsTrustedSender(ctx, 1, 2); !ok {
		t.Error("blocked user's trust in the blocker was revoked, want untouched")
	}
	res, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(res.RequestCreatedFor) != 1 {
		t.Errorf("RequestCreatedFor = %v, want one pending request", res.RequestCreatedFor)
	}
}

// A request the blocker already decided (here: accepted) must not swallow the
// sender's first message after block + unblock: the pair gets a fresh request.
func TestBlockUser_ResetsDecidedRequestSoNextSendIsARequestAgain(t *testing.T) {
	_, svc := newMessageRequestFixture(t)
	ctx := context.Background()
	first, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi",
	})
	if err != nil || len(first.RequestCreatedFor) != 1 {
		t.Fatalf("first send: %v, RequestCreatedFor=%v", err, first.RequestCreatedFor)
	}
	if _, err := svc.MessageRequests.Accept(ctx, 2, first.RequestCreatedFor[0].ID); err != nil {
		t.Fatalf("Accept: %v", err)
	}

	if err := svc.Blocks.BlockUser(ctx, 2, 1); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	if err := svc.Blocks.UnblockUser(ctx, 2, 1); err != nil {
		t.Fatalf("UnblockUser: %v", err)
	}

	again, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi again",
	})
	if err != nil {
		t.Fatalf("SendMessage after unblock: %v", err)
	}
	if len(again.RequestCreatedFor) != 1 {
		t.Errorf("RequestCreatedFor = %v, want a fresh request", again.RequestCreatedFor)
	}
}

// Unblocking someone who is not blocked is a no-op: it must not erase an
// ignored request, or the sender's next message would raise a fresh one.
func TestUnblockUser_NotBlockedKeepsIgnoredRequest(t *testing.T) {
	_, svc := newMessageRequestFixture(t)
	ctx := context.Background()
	first, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi",
	})
	if err != nil || len(first.RequestCreatedFor) != 1 {
		t.Fatalf("first send: %v, RequestCreatedFor=%v", err, first.RequestCreatedFor)
	}
	if _, err := svc.MessageRequests.Ignore(ctx, 2, first.RequestCreatedFor[0].ID); err != nil {
		t.Fatalf("Ignore: %v", err)
	}

	if err := svc.Blocks.UnblockUser(ctx, 2, 1); err != nil {
		t.Fatalf("UnblockUser: %v", err)
	}

	again, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi again",
	})
	if err != nil {
		t.Fatalf("SendMessage after no-op unblock: %v", err)
	}
	if len(again.RequestCreatedFor) != 0 {
		t.Errorf("RequestCreatedFor = %v, want none (request stays ignored)", again.RequestCreatedFor)
	}
}
