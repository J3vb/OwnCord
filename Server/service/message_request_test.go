package service

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// newMessageRequestFixture builds the full service bundle (service.New) over
// newDMFixture's two-user, untrusted, one-to-one DM (alice=1, bob=2,
// channel=50) — the fixture's whole point is that neither party trusts the
// other yet, which is what B5-6's gate needs to engage.
func newMessageRequestFixture(t *testing.T) (*db.DB, *Services) {
	t.Helper()
	database, _ := newDMFixture(t)
	return database, New(database, nil)
}

func countRows(t *testing.T, database *db.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

// TestMessageRequest_BlockedSenderCreatesNoRequest: a block refuses the send
// itself (the existing checkSendPermission gate), in either direction, before
// the first-contact gate ever runs — no message, no request.
func TestMessageRequest_BlockedSenderCreatesNoRequest(t *testing.T) {
	for _, tc := range []struct {
		name           string
		blockerBlocked func(database *db.DB) (blocker, blocked int64)
	}{
		{"sender_blocked_by_recipient", func(*db.DB) (int64, int64) { return 2, 1 }}, // bob blocked alice
		{"recipient_blocked_by_sender", func(*db.DB) (int64, int64) { return 1, 2 }}, // alice blocked bob
	} {
		t.Run(tc.name, func(t *testing.T) {
			database, svc := newMessageRequestFixture(t)
			ctx := context.Background()
			blocker, blocked := tc.blockerBlocked(database)
			if err := database.BlockUser(ctx, blocker, blocked); err != nil {
				t.Fatalf("BlockUser: %v", err)
			}

			_, err := svc.Messages.SendMessage(ctx, SendMessageParams{
				ChannelID: 50, UserID: 1, Username: "alice", Content: "hi",
			})
			if !errors.Is(err, ErrBlocked) {
				t.Fatalf("SendMessage = %v, want ErrBlocked", err)
			}
			if n := countRows(t, database, `SELECT COUNT(*) FROM message_requests`); n != 0 {
				t.Errorf("message_requests rows = %d, want 0", n)
			}
			if n := countRows(t, database, `SELECT COUNT(*) FROM messages WHERE channel_id = 50`); n != 0 {
				t.Errorf("messages rows = %d, want 0 (refused before persisting)", n)
			}
		})
	}
}

// TestMessageRequest_BannedRecipientGetsNoRequest: "cannot receive DMs" is
// the ban state today (community-services.md S1) — a banned recipient gets
// no request row, no OpenDM, and does not appear in the delivery audience,
// but the sender's send still succeeds (decision 5).
func TestMessageRequest_BannedRecipientGetsNoRequest(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	ctx := context.Background()
	if err := database.BanUser(ctx, 2, "test", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	result, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(result.RequestCreatedFor) != 0 {
		t.Errorf("RequestCreatedFor = %v, want none", result.RequestCreatedFor)
	}
	if len(result.OpenedDMFor) != 0 {
		t.Errorf("OpenedDMFor = %v, want none", result.OpenedDMFor)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM message_requests`); n != 0 {
		t.Errorf("message_requests rows = %d, want 0", n)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM trusted_senders`); n != 0 {
		t.Errorf("trusted_senders rows = %d, want 0 (banned skip means no sent_first row either)", n)
	}
	for _, pid := range result.ParticipantIDs {
		if pid == 2 {
			t.Error("banned recipient is in the live-delivery audience")
		}
	}
}

// TestMessageRequest_AcceptDoesNotResurrectDeletedContent: the sender deletes
// the held message before the recipient ever accepts; acceptance opens the
// channel but must not touch the messages table at all.
func TestMessageRequest_AcceptDoesNotResurrectDeletedContent(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	ctx := context.Background()

	sendResult, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "secret",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(sendResult.RequestCreatedFor) != 1 {
		t.Fatalf("RequestCreatedFor = %v, want exactly one", sendResult.RequestCreatedFor)
	}
	reqID := sendResult.RequestCreatedFor[0].ID

	if _, err := svc.Messages.DeleteMessage(ctx, 1, sendResult.MessageID); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	updated, err := svc.MessageRequests.Accept(ctx, 2, reqID)
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if updated.State != msgReqAccepted {
		t.Fatalf("state = %q, want accepted", updated.State)
	}

	var deleted int
	if err := database.QueryRowContext(ctx, `SELECT deleted FROM messages WHERE id = ?`, sendResult.MessageID).Scan(&deleted); err != nil {
		t.Fatalf("read message: %v", err)
	}
	if deleted == 0 {
		t.Error("accepting the request un-deleted the message")
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM dm_open_state WHERE user_id = 2 AND channel_id = 50`); n != 1 {
		t.Errorf("dm_open_state rows for the recipient = %d, want 1 (the channel opened on accept)", n)
	}
}

// TestMessageRequest_ResendAfterIgnoreCreatesNothing: one row per pair ever
// (decision 5) — a second send while the request is ignored creates no
// second request and no second notification.
func TestMessageRequest_ResendAfterIgnoreCreatesNothing(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	ctx := context.Background()

	first, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi",
	})
	if err != nil {
		t.Fatalf("SendMessage(1): %v", err)
	}
	if len(first.RequestCreatedFor) != 1 {
		t.Fatalf("first send: RequestCreatedFor = %v, want one", first.RequestCreatedFor)
	}
	reqID := first.RequestCreatedFor[0].ID

	if _, err := svc.MessageRequests.Ignore(ctx, 2, reqID); err != nil {
		t.Fatalf("Ignore: %v", err)
	}

	second, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi again",
	})
	if err != nil {
		t.Fatalf("SendMessage(2): %v", err)
	}
	if len(second.RequestCreatedFor) != 0 {
		t.Errorf("second send: RequestCreatedFor = %v, want none", second.RequestCreatedFor)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM message_requests`); n != 1 {
		t.Errorf("message_requests rows = %d, want 1 (one row, ever)", n)
	}
}

// TestMessageRequest_SentFirstMeansTheReplyIsNotARequest: the recipient's
// eventual reply is not staged as a first-contact request back, because the
// original sender already trusts them (source "sent_first").
func TestMessageRequest_SentFirstMeansTheReplyIsNotARequest(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	ctx := context.Background()

	if _, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi",
	}); err != nil {
		t.Fatalf("SendMessage(alice): %v", err)
	}

	reply, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 2, Username: "bob", Content: "who is this",
	})
	if err != nil {
		t.Fatalf("SendMessage(bob): %v", err)
	}
	if len(reply.RequestCreatedFor) != 0 {
		t.Errorf("bob's reply created a request: %v", reply.RequestCreatedFor)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM message_requests`); n != 1 {
		t.Errorf("message_requests rows = %d, want 1 (only alice's original)", n)
	}
	// bob's reply must reach alice live, exactly like an ordinary DM message.
	if len(reply.ParticipantIDs) != 2 {
		t.Errorf("ParticipantIDs = %v, want both alice and bob", reply.ParticipantIDs)
	}
}

// dmRequestActionFn is one of the four recipient transitions, for the
// state-machine tests below.
type dmRequestActionFn func(svc *Services, ctx context.Context, recipientID, id int64) (*db.MessageRequest, error)

var dmRequestActions = map[string]dmRequestActionFn{
	"accept": func(svc *Services, ctx context.Context, r, id int64) (*db.MessageRequest, error) {
		return svc.MessageRequests.Accept(ctx, r, id)
	},
	"ignore": func(svc *Services, ctx context.Context, r, id int64) (*db.MessageRequest, error) {
		return svc.MessageRequests.Ignore(ctx, r, id)
	},
	"delete": func(svc *Services, ctx context.Context, r, id int64) (*db.MessageRequest, error) {
		return svc.MessageRequests.Delete(ctx, r, id)
	},
	"block": func(svc *Services, ctx context.Context, r, id int64) (*db.MessageRequest, error) {
		return svc.MessageRequests.Block(ctx, r, id)
	},
}

var dmRequestWantState = map[string]string{
	"accept": msgReqAccepted, "ignore": msgReqIgnored, "delete": msgReqDeleted, "block": msgReqBlocked,
}

// TestMessageRequest_OnlyPendingTransitions: each of the four legal
// transitions succeeds exactly once from pending, and every transition
// (including a repeat of the one that just won) is illegal afterward.
func TestMessageRequest_OnlyPendingTransitions(t *testing.T) {
	for name, action := range dmRequestActions {
		t.Run(name, func(t *testing.T) {
			_, svc := newMessageRequestFixture(t)
			ctx := context.Background()
			sendResult, err := svc.Messages.SendMessage(ctx, SendMessageParams{
				ChannelID: 50, UserID: 1, Username: "alice", Content: "hi",
			})
			if err != nil {
				t.Fatalf("SendMessage: %v", err)
			}
			id := sendResult.RequestCreatedFor[0].ID

			got, err := action(svc, ctx, 2, id)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if got.State != dmRequestWantState[name] {
				t.Errorf("state = %q, want %q", got.State, dmRequestWantState[name])
			}

			for name2, action2 := range dmRequestActions {
				if _, err := action2(svc, ctx, 2, id); !errors.Is(err, ErrConflict) {
					t.Errorf("%s after %s: err = %v, want ErrConflict", name2, name, err)
				}
			}
		})
	}
}

// TestMessageRequest_OnlyRecipientDecides: the sender, and an unrelated third
// user, both get 404 on every transition — the row exists, just not for them.
func TestMessageRequest_OnlyRecipientDecides(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 3, Username: "carol"})

	sendResult, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	id := sendResult.RequestCreatedFor[0].ID

	for name, action := range dmRequestActions {
		for _, actor := range []int64{1, 3} {
			if _, err := action(svc, ctx, actor, id); !errors.Is(err, ErrNotFound) {
				t.Errorf("%s by actor %d: err = %v, want ErrNotFound", name, actor, err)
			}
		}
	}
}

// TestMessageRequest_ConcurrentDecisionsOneWins: two goroutines decide the
// same pending row at once — exactly one 200, one 409, and the trust
// bookkeeping reflects whichever one actually won, never both.
func TestMessageRequest_ConcurrentDecisionsOneWins(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	ctx := context.Background()

	sendResult, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	id := sendResult.RequestCreatedFor[0].ID

	var acceptErr, ignoreErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _, acceptErr = svc.MessageRequests.Accept(ctx, 2, id) }()
	go func() { defer wg.Done(); _, ignoreErr = svc.MessageRequests.Ignore(ctx, 2, id) }()
	wg.Wait()

	acceptWon, ignoreWon := acceptErr == nil, ignoreErr == nil
	if acceptWon == ignoreWon {
		t.Fatalf("expected exactly one winner: acceptErr=%v ignoreErr=%v", acceptErr, ignoreErr)
	}
	if acceptWon && !errors.Is(ignoreErr, ErrConflict) {
		t.Errorf("ignore (loser) = %v, want ErrConflict", ignoreErr)
	}
	if ignoreWon && !errors.Is(acceptErr, ErrConflict) {
		t.Errorf("accept (loser) = %v, want ErrConflict", acceptErr)
	}

	wantAccepted := 0
	if acceptWon {
		wantAccepted = 1
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM trusted_senders WHERE source = 'accepted'`); n != wantAccepted {
		t.Errorf("accepted-source trusted_senders rows = %d, want %d", n, wantAccepted)
	}
}
