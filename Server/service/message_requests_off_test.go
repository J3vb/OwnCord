package service

import (
	"context"
	"errors"
	"slices"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// WP 6.8e: a recipient with message requests off (and direct messages on) is
// reached by a first send directly. Fixture: alice (1) and bob (2) share the
// 1:1 DM 50 and neither trusts the other (newDMFixture).

func setPrivacy(t *testing.T, database *db.DB, userID int64, allowDMs, requests bool) {
	t.Helper()
	if err := database.SetUserPrivacy(context.Background(), userID, db.UserPrivacy{AllowMemberDMs: allowDMs, MessageRequests: requests}); err != nil {
		t.Fatalf("SetUserPrivacy(%d): %v", userID, err)
	}
}

func sendFirst(t *testing.T, svc *Services, from int64, content string) *SendMessageResult {
	t.Helper()
	res, err := svc.Messages.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 50, UserID: from, Username: "u", Content: content,
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	return res
}

func sorted(ids []int64) []int64 {
	out := slices.Clone(ids)
	slices.Sort(out)
	return out
}

type pushRecorder struct {
	mu         sync.Mutex
	candidates [][]int64
}

func (r *pushRecorder) Notify(_ context.Context, _, _ int64, candidates []int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.candidates = append(r.candidates, slices.Clone(candidates))
}

func (r *pushRecorder) all() []int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []int64
	for _, c := range r.candidates {
		out = append(out, c...)
	}
	return out
}

func TestRequestsOff_FirstSendDeliveredLive(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	setPrivacy(t, database, 2, true, false)

	res := sendFirst(t, svc, 1, "hi bob")

	if !slices.Equal(sorted(res.ParticipantIDs), []int64{1, 2}) {
		t.Errorf("ParticipantIDs = %v, want [1 2]", res.ParticipantIDs)
	}
	if !slices.Equal(res.OpenedDMFor, []int64{2}) {
		t.Errorf("OpenedDMFor = %v, want [2] so dm_channel_open goes out", res.OpenedDMFor)
	}
	if len(res.RequestCreatedFor) != 0 || res.RequestPreview != nil {
		t.Errorf("RequestCreatedFor = %v, RequestPreview = %v, want no dm_request", res.RequestCreatedFor, res.RequestPreview)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM message_requests WHERE sender_id = 1 AND recipient_id = 2 AND state = 'accepted' AND decided_at IS NOT NULL`); n != 1 {
		t.Errorf("accepted request rows = %d, want 1", n)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM trusted_senders WHERE recipient_id = 2 AND sender_id = 1 AND source = 'accepted'`); n != 1 {
		t.Errorf("accepted trust rows = %d, want 1", n)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM trusted_senders WHERE recipient_id = 1 AND sender_id = 2 AND source = 'sent_first'`); n != 1 {
		t.Errorf("sent_first trust rows = %d, want 1", n)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM dm_open_state WHERE user_id = 2 AND channel_id = 50`); n != 1 {
		t.Errorf("recipient dm_open_state rows = %d, want 1", n)
	}
	reqs, err := svc.MessageRequests.ListPending(context.Background(), 2)
	if err != nil || len(reqs) != 0 {
		t.Errorf("inbox = %v, %v; want empty", reqs, err)
	}
}

func TestRequestsOn_FirstSendStillStaged(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	setPrivacy(t, database, 2, true, true)

	res := sendFirst(t, svc, 1, "hi bob")

	if len(res.RequestCreatedFor) != 1 || len(res.OpenedDMFor) != 0 {
		t.Errorf("RequestCreatedFor = %v, OpenedDMFor = %v; want one request, no open", res.RequestCreatedFor, res.OpenedDMFor)
	}
	if !slices.Equal(res.ParticipantIDs, []int64{1}) {
		t.Errorf("ParticipantIDs = %v, want [1]", res.ParticipantIDs)
	}
}

func TestRequestsOff_MentionCountedAndPushQueued(t *testing.T) {
	for _, tc := range []struct {
		name     string
		requests bool
		want     bool
	}{{"requests_off", false, true}, {"requests_on", true, false}} {
		t.Run(tc.name, func(t *testing.T) {
			database, svc := newMessageRequestFixture(t)
			setPrivacy(t, database, 2, true, tc.requests)
			rec := &pushRecorder{}
			svc.Messages.SetPushNotifier(rec)
			svc.Messages.RunBackgroundInlineForTest()

			sendFirst(t, svc, 1, "hello @bob")

			mentions := countRows(t, database, `SELECT COALESCE(SUM(mention_count), 0) FROM read_states WHERE user_id = 2 AND channel_id = 50`)
			if (mentions == 1) != tc.want {
				t.Errorf("bob's mention count = %d, want counted = %v", mentions, tc.want)
			}
			if got := slices.Contains(rec.all(), 2); got != tc.want {
				t.Errorf("push candidates %v include bob = %v, want %v", rec.all(), got, tc.want)
			}
		})
	}
}

func TestRequestsOff_ReEnableKeepsPairTrusted(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	setPrivacy(t, database, 2, true, false)
	sendFirst(t, svc, 1, "first")

	setPrivacy(t, database, 2, true, true)
	res := sendFirst(t, svc, 1, "second")

	if !slices.Equal(sorted(res.ParticipantIDs), []int64{1, 2}) {
		t.Errorf("ParticipantIDs = %v, want [1 2]: the pair stays trusted", res.ParticipantIDs)
	}
	if len(res.RequestCreatedFor) != 0 || len(res.OpenedDMFor) != 0 {
		t.Errorf("RequestCreatedFor = %v, OpenedDMFor = %v; want none", res.RequestCreatedFor, res.OpenedDMFor)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM message_requests`); n != 1 {
		t.Errorf("message_requests rows = %d, want 1", n)
	}
}

func TestRequestsOff_WithDMsOffIsRefused(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	setPrivacy(t, database, 2, false, false)

	res, err := svc.Messages.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi",
	})
	if !errors.Is(err, ErrBlocked) || res != nil {
		t.Fatalf("SendMessage = %v, %v; want ErrBlocked and no result", res, err)
	}
	for _, table := range []string{"messages", "message_requests", "trusted_senders", "dm_open_state"} {
		if n := countRows(t, database, `SELECT COUNT(*) FROM `+table+` WHERE 1 = 1`); n != 0 {
			t.Errorf("%s rows = %d, want 0", table, n)
		}
	}
}

// Edge 1: the setting changes after the gate's reads and before the
// transaction. The transaction's own read decides, so the message is staged
// and never delivered.
func TestRequestsOff_FlipDuringFirstSendIsDecidedInTransaction(t *testing.T) {
	for _, tc := range []struct {
		name            string
		allowDMs, reqOn bool
	}{{"requests_back_on", true, true}, {"dms_turned_off", false, false}} {
		t.Run(tc.name, func(t *testing.T) {
			database, svc := newMessageRequestFixture(t)
			setPrivacy(t, database, 2, true, false)
			svc.Messages.afterFirstContactTrustCheck = func() { setPrivacy(t, database, 2, tc.allowDMs, tc.reqOn) }

			res := sendFirst(t, svc, 1, "hi")

			if len(res.RequestCreatedFor) != 1 || len(res.OpenedDMFor) != 0 {
				t.Errorf("RequestCreatedFor = %v, OpenedDMFor = %v; want one pending request, no open", res.RequestCreatedFor, res.OpenedDMFor)
			}
			if !slices.Equal(res.ParticipantIDs, []int64{1}) {
				t.Errorf("ParticipantIDs = %v, want [1]: never delivered after the switch", res.ParticipantIDs)
			}
			if n := countRows(t, database, `SELECT COUNT(*) FROM message_requests WHERE state = 'pending'`); n != 1 {
				t.Errorf("pending rows = %d, want 1", n)
			}
			if n := countRows(t, database, `SELECT COUNT(*) FROM trusted_senders WHERE recipient_id = 2`); n != 0 {
				t.Errorf("recipient trust rows = %d, want 0", n)
			}
			if n := countRows(t, database, `SELECT COUNT(*) FROM dm_open_state WHERE user_id = 2`); n != 0 {
				t.Errorf("recipient dm_open_state rows = %d, want 0", n)
			}
		})
	}
}

// Edge 2: two first sends race. The same sender twice: one row, one open,
// both messages delivered. Both directions: one row each, both delivered.
func TestRequestsOff_RacingFirstSends(t *testing.T) {
	for _, tc := range []struct {
		name     string
		senders  [2]int64
		wantRows int
	}{{"same_sender_twice", [2]int64{1, 1}, 1}, {"both_directions", [2]int64{1, 2}, 2}} {
		t.Run(tc.name, func(t *testing.T) {
			database, svc := newMessageRequestFixture(t)
			setPrivacy(t, database, 1, true, false)
			setPrivacy(t, database, 2, true, false)
			ctx := context.Background()

			barrier := make(chan struct{})
			var arrived atomic.Int32
			svc.Messages.afterFirstContactTrustCheck = func() {
				if arrived.Add(1) == 2 {
					close(barrier)
				}
				<-barrier
			}

			var wg sync.WaitGroup
			results := make([]*SendMessageResult, 2)
			errs := make([]error, 2)
			wg.Add(2)
			for i := range 2 {
				go func() {
					defer wg.Done()
					results[i], errs[i] = svc.Messages.SendMessage(ctx, SendMessageParams{
						ChannelID: 50, UserID: tc.senders[i], Username: "u", Content: "hi",
					})
				}()
			}
			wg.Wait()

			opened := 0
			for i, r := range results {
				if errs[i] != nil {
					t.Fatalf("send %d: %v", i, errs[i])
				}
				if !slices.Equal(sorted(r.ParticipantIDs), []int64{1, 2}) {
					t.Errorf("send %d: ParticipantIDs = %v, want [1 2]: neither send may be lost", i, r.ParticipantIDs)
				}
				if len(r.RequestCreatedFor) != 0 {
					t.Errorf("send %d: RequestCreatedFor = %v, want none", i, r.RequestCreatedFor)
				}
				opened += len(r.OpenedDMFor)
			}
			if tc.name == "same_sender_twice" && opened != 1 {
				t.Errorf("dm_channel_open announcements = %d, want exactly 1", opened)
			}
			if n := countRows(t, database, `SELECT COUNT(*) FROM message_requests WHERE state = 'accepted'`); n != tc.wantRows {
				t.Errorf("accepted request rows = %d, want %d", n, tc.wantRows)
			}
			if n := countRows(t, database, `SELECT COUNT(*) FROM message_requests`); n != tc.wantRows {
				t.Errorf("request rows = %d, want %d", n, tc.wantRows)
			}
			if n := countRows(t, database, `SELECT COUNT(*) FROM messages WHERE channel_id = 50`); n != 2 {
				t.Errorf("messages = %d, want 2", n)
			}
		})
	}
}

// A request already in the inbox when the setting goes off stays pending and
// keeps holding the sender's messages until the recipient decides.
func TestRequestsOff_PendingRequestsStayPending(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	ctx := context.Background()
	first := sendFirst(t, svc, 1, "first")
	if len(first.RequestCreatedFor) != 1 {
		t.Fatalf("RequestCreatedFor = %v, want one", first.RequestCreatedFor)
	}

	setPrivacy(t, database, 2, true, false)
	again := sendFirst(t, svc, 1, "again")

	if !slices.Equal(again.ParticipantIDs, []int64{1}) || len(again.OpenedDMFor) != 0 || len(again.RequestCreatedFor) != 0 {
		t.Errorf("resend: ParticipantIDs = %v, OpenedDMFor = %v, RequestCreatedFor = %v; want held for the recipient", again.ParticipantIDs, again.OpenedDMFor, again.RequestCreatedFor)
	}
	pending, err := svc.MessageRequests.ListPending(ctx, 2)
	if err != nil || len(pending) != 1 || pending[0].State != "pending" {
		t.Fatalf("inbox = %v, %v; want the one pending request", pending, err)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM trusted_senders WHERE recipient_id = 2`); n != 0 {
		t.Errorf("recipient trust rows = %d, want 0", n)
	}
}
