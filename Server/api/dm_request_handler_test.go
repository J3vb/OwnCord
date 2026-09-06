package api_test

// dm_request_handler_test.go covers the B5-6 REST surface
// (/api/v1/dm-requests): the inbox listing, the four recipient-only
// transitions and their status codes, and the decision-5 property that the
// sender's REST view (GET /api/v1/dms, GET /channels/{id}/messages) does not
// vary with the recipient's decision. The chat_send_ok/chat_message half of
// decision 5 and the live-delivery audience are ws/dm_request_test.go's job
// — this file only has REST to read from.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// buildDMRequestRouter mounts every route these tests touch: DM creation
// (unused directly, but MountDMRoutes shares svc wiring), the message-request
// inbox, and channel message history — all over the same *db.DB and
// *service.Services so a message sent through svc.Messages is visible to
// every route.
func buildDMRequestRouter(database *db.DB, broadcaster api.DMBroadcaster) (http.Handler, *service.Services) {
	r := chi.NewRouter()
	svc := service.New(database, auth.NewRateLimiter())
	api.MountDMRoutes(r, database, svc, broadcaster)
	api.MountDMRequestRoutes(r, svc, broadcaster)
	api.MountChannelRoutes(r, database, svc, auth.NewRateLimiter(), nil, nil)
	return r, svc
}

// seedOneToOneDM creates two users, an untrusted one-to-one DM channel
// between them, and returns their ids, tokens and the channel id.
func seedOneToOneDM(t *testing.T, database *db.DB, senderName, recipientName string) (senderID, recipientID, channelID int64, senderTok, recipientTok string) {
	t.Helper()
	senderTok = dmCreateToken(t, database, senderName, 4)
	recipientTok = dmCreateToken(t, database, recipientName, 4)
	senderID = mustUserID(t, database, senderName)
	recipientID = mustUserID(t, database, recipientName)
	ch, _, err := database.GetOrCreateDMChannel(context.Background(), senderID, recipientID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	return senderID, recipientID, ch.ID, senderTok, recipientTok
}

// dmOpenStateCount reports how many dm_open_state rows userID has for
// channelID — 0 or 1, since (user_id, channel_id) is the table's key.
func dmOpenStateCount(t *testing.T, database *db.DB, userID, channelID int64) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM dm_open_state WHERE user_id = ? AND channel_id = ?`, userID, channelID).Scan(&n); err != nil {
		t.Fatalf("dm_open_state count: %v", err)
	}
	return n
}

func mustUserID(t *testing.T, database *db.DB, username string) int64 {
	t.Helper()
	u, err := database.GetUserByUsername(context.Background(), username)
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername(%q): %v", username, err)
	}
	return u.ID
}

func decodeJSON[T any](t *testing.T, body []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return v
}

// TestDMRequestHandler_ListPending_ReturnsShapeWithPreview proves GET / lists
// the pending request with the sender's profile and a preview of the held
// message.
func TestDMRequestHandler_ListPending_ReturnsShapeWithPreview(t *testing.T) {
	database := newDMTestDB(t)
	router, svc := buildDMRequestRouter(database, &mockBroadcaster{})
	_, recipientID, channelID, _, recipientTok := seedOneToOneDM(t, database, "alice", "bob")

	sendResult, err := svc.Messages.SendMessage(context.Background(), service.SendMessageParams{
		ChannelID: channelID, UserID: mustUserID(t, database, "alice"), Username: "alice", Content: "hi bob",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(sendResult.RequestCreatedFor) != 1 {
		t.Fatalf("RequestCreatedFor = %v, want one", sendResult.RequestCreatedFor)
	}

	rr := dmGet(t, router, "/api/v1/dm-requests", recipientTok)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET /dm-requests = %d, body=%s", rr.Code, rr.Body.String())
	}
	var body struct {
		Requests []struct {
			ID        int64 `json:"id"`
			ChannelID int64 `json:"channel_id"`
			Sender    struct {
				ID       int64  `json:"id"`
				Username string `json:"username"`
			} `json:"sender"`
			Preview *struct {
				MessageID int64  `json:"message_id"`
				Content   string `json:"content"`
			} `json:"preview"`
			CreatedAt string `json:"created_at"`
		} `json:"requests"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v; body=%s", err, rr.Body.String())
	}
	if len(body.Requests) != 1 {
		t.Fatalf("requests = %d, want 1", len(body.Requests))
	}
	got := body.Requests[0]
	if got.ChannelID != channelID || got.Sender.ID != mustUserID(t, database, "alice") || got.Sender.Username != "alice" {
		t.Errorf("request = %+v", got)
	}
	if got.Preview == nil || got.Preview.Content != "hi bob" {
		t.Errorf("preview = %+v, want the held message", got.Preview)
	}
	_ = recipientID
}

// TestDMRequestHandler_Accept_OpensChannelAndNotifies: 200, state accepted,
// the channel opens for the recipient, and the recipient's other devices get
// a dm_channel_open plus a dm_request(state=accepted). Codex review round 2,
// P1: seedOneToOneDM opens BOTH sides unconditionally (GetOrCreateDMChannel),
// so it cannot exercise "accept is what opens the recipient's side" — the
// row would already be there before Accept ever ran. Seed through
// GetOrCreateDMChannelGated instead: alice and bob start untrusted, so the
// channel is created with only alice's (the caller's) side open, and the
// assertion is the row count's actual 0 -> 1 transition, not just whether a
// broadcast happened to fire.
func TestDMRequestHandler_Accept_OpensChannelAndNotifies(t *testing.T) {
	database := newDMTestDB(t)
	broadcaster := &mockBroadcaster{}
	router, svc := buildDMRequestRouter(database, broadcaster)
	_ = dmCreateToken(t, database, "alice", 4)
	recipientTok := dmCreateToken(t, database, "bob", 4)
	senderID := mustUserID(t, database, "alice")
	recipientID := mustUserID(t, database, "bob")
	ch, created, recipientOpened, err := database.GetOrCreateDMChannelGated(context.Background(), senderID, recipientID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannelGated: %v", err)
	}
	if !created || recipientOpened {
		t.Fatalf("GetOrCreateDMChannelGated = created=%v recipientOpened=%v, want true, false (untrusted pair)", created, recipientOpened)
	}
	channelID := ch.ID

	openCountBefore := dmOpenStateCount(t, database, recipientID, channelID)
	if openCountBefore != 0 {
		t.Fatalf("dm_open_state rows for the recipient before accept = %d, want 0", openCountBefore)
	}

	sendResult, err := svc.Messages.SendMessage(context.Background(), service.SendMessageParams{
		ChannelID: channelID, UserID: senderID, Username: "alice", Content: "hi bob",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	reqID := sendResult.RequestCreatedFor[0].ID

	rr := dmPost(t, router, fmt.Sprintf("/api/v1/dm-requests/%d/accept", reqID), recipientTok, map[string]any{})
	if rr.Code != http.StatusOK {
		t.Fatalf("accept = %d, body=%s", rr.Code, rr.Body.String())
	}
	resp := decodeJSON[struct {
		ID        int64  `json:"id"`
		State     string `json:"state"`
		DecidedAt string `json:"decided_at"`
	}](t, rr.Body.Bytes())
	if resp.State != "accepted" || resp.DecidedAt == "" {
		t.Errorf("response = %+v", resp)
	}

	if opened := dmOpenStateCount(t, database, recipientID, channelID); opened != 1 {
		t.Errorf("dm_open_state rows for the recipient after accept = %d, want 1 (the 0 -> 1 transition Accept must perform)", opened)
	}

	var sawOpen, sawRequest bool
	for _, m := range broadcaster.sent {
		if m.UserID != recipientID {
			continue
		}
		var frame map[string]any
		if err := json.Unmarshal(m.Msg, &frame); err != nil {
			t.Fatalf("decode broadcast: %v", err)
		}
		switch frame["type"] {
		case "dm_channel_open":
			sawOpen = true
		case "dm_request":
			sawRequest = true
			payload, _ := frame["payload"].(map[string]any)
			if payload["state"] != "accepted" {
				t.Errorf("dm_request push state = %v, want accepted", payload["state"])
			}
			if payload["preview"] != nil {
				t.Errorf("dm_request push on a transition must carry no preview, got %v", payload["preview"])
			}
		}
	}
	if !sawOpen || !sawRequest {
		t.Errorf("broadcaster saw open=%v request=%v, want both", sawOpen, sawRequest)
	}
}

// TestDMRequestHandler_TransitionThenTransitionAgainIsConflict: the second
// decision on an already-decided row is 409.
func TestDMRequestHandler_TransitionThenTransitionAgainIsConflict(t *testing.T) {
	database := newDMTestDB(t)
	router, svc := buildDMRequestRouter(database, &mockBroadcaster{})
	senderID, _, channelID, _, recipientTok := seedOneToOneDM(t, database, "alice", "bob")

	sendResult, err := svc.Messages.SendMessage(context.Background(), service.SendMessageParams{
		ChannelID: channelID, UserID: senderID, Username: "alice", Content: "hi bob",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	reqID := sendResult.RequestCreatedFor[0].ID
	path := fmt.Sprintf("/api/v1/dm-requests/%d/ignore", reqID)

	if rr := dmPost(t, router, path, recipientTok, map[string]any{}); rr.Code != http.StatusOK {
		t.Fatalf("first ignore = %d, body=%s", rr.Code, rr.Body.String())
	}
	rr := dmPost(t, router, path, recipientTok, map[string]any{})
	if rr.Code != http.StatusConflict {
		t.Fatalf("second ignore = %d, want 409, body=%s", rr.Code, rr.Body.String())
	}
}

// TestDMRequestHandler_TransitionByNonRecipientIsNotFound: neither the
// sender nor an unrelated user can decide someone else's request.
func TestDMRequestHandler_TransitionByNonRecipientIsNotFound(t *testing.T) {
	database := newDMTestDB(t)
	router, svc := buildDMRequestRouter(database, &mockBroadcaster{})
	senderID, _, channelID, senderTok, _ := seedOneToOneDM(t, database, "alice", "bob")
	thirdTok := dmCreateToken(t, database, "carol", 4)

	sendResult, err := svc.Messages.SendMessage(context.Background(), service.SendMessageParams{
		ChannelID: channelID, UserID: senderID, Username: "alice", Content: "hi bob",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	reqID := sendResult.RequestCreatedFor[0].ID
	path := fmt.Sprintf("/api/v1/dm-requests/%d/ignore", reqID)

	for _, tok := range []string{senderTok, thirdTok} {
		rr := dmPost(t, router, path, tok, map[string]any{})
		if rr.Code != http.StatusNotFound {
			t.Errorf("ignore by a non-recipient = %d, want 404, body=%s", rr.Code, rr.Body.String())
		}
	}
}

// TestDMRequestHandler_Block_BlocksTheSenderAndTransitions: block runs
// BlockService.BlockUser (its existing side effects) and only then
// transitions to blocked.
func TestDMRequestHandler_Block_BlocksTheSenderAndTransitions(t *testing.T) {
	database := newDMTestDB(t)
	router, svc := buildDMRequestRouter(database, &mockBroadcaster{})
	senderID, recipientID, channelID, _, recipientTok := seedOneToOneDM(t, database, "alice", "bob")

	sendResult, err := svc.Messages.SendMessage(context.Background(), service.SendMessageParams{
		ChannelID: channelID, UserID: senderID, Username: "alice", Content: "hi bob",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	reqID := sendResult.RequestCreatedFor[0].ID

	rr := dmPost(t, router, fmt.Sprintf("/api/v1/dm-requests/%d/block", reqID), recipientTok, map[string]any{})
	if rr.Code != http.StatusOK {
		t.Fatalf("block = %d, body=%s", rr.Code, rr.Body.String())
	}
	resp := decodeJSON[struct {
		State string `json:"state"`
	}](t, rr.Body.Bytes())
	if resp.State != "blocked" {
		t.Errorf("state = %q, want blocked", resp.State)
	}
	var blocked int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?`, recipientID, senderID).Scan(&blocked); err != nil || blocked != 1 {
		t.Errorf("user_blocks rows = %d, %v; want 1", blocked, err)
	}
}

// TestDMRequestHandler_Block_EvictsSenderFromSharedDMVoice is Codex P1-3:
// blocking through the request endpoint must run the same voice eviction
// PUT /api/v1/blocks/{id} does — the two endpoints share
// evictBlockedUserFromVoice (dm_handler.go).
func TestDMRequestHandler_Block_EvictsSenderFromSharedDMVoice(t *testing.T) {
	database := newDMTestDB(t)
	bc := &watermarkVoiceBroadcaster{mockBroadcaster: &mockBroadcaster{}}
	router, svc := buildDMRequestRouter(database, bc)
	senderID, _, channelID, _, recipientTok := seedOneToOneDM(t, database, "alice", "bob")

	sendResult, err := svc.Messages.SendMessage(context.Background(), service.SendMessageParams{
		ChannelID: channelID, UserID: senderID, Username: "alice", Content: "hi bob",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	reqID := sendResult.RequestCreatedFor[0].ID
	bc.evictCalls = nil

	rr := dmPost(t, router, fmt.Sprintf("/api/v1/dm-requests/%d/block", reqID), recipientTok, map[string]any{})
	if rr.Code != http.StatusOK {
		t.Fatalf("block = %d, body=%s", rr.Code, rr.Body.String())
	}

	if len(bc.evictCalls) != 1 || bc.evictCalls[0].userID != senderID || bc.evictCalls[0].channelID != channelID {
		t.Fatalf("DisconnectFromVoiceInChannel calls = %+v, want exactly one for user=%d channel=%d",
			bc.evictCalls, senderID, channelID)
	}
}

// raceAfterBlockStore wraps a real *db.DB and, the instant BlockUser
// commits, flips the request's OWN row to "ignored" directly — simulating
// another decision winning the race between BlockUser committing and this
// request's own guarded transition to "blocked". The transition below must
// then lose (409, state already decided), but BlockUser already committed.
type raceAfterBlockStore struct {
	*db.DB
	requestID int64
}

func (s *raceAfterBlockStore) BlockUser(ctx context.Context, blockerID, blockedID int64) error {
	if err := s.DB.BlockUser(ctx, blockerID, blockedID); err != nil {
		return err
	}
	_, err := s.ExecContext(ctx, `UPDATE message_requests SET state = 'ignored', decided_at = datetime('now') WHERE id = ?`, s.requestID)
	return err
}

// TestDMRequestHandler_Block_EvictsEvenWhenTransitionLosesRace is Codex
// P1-3's other half: the eviction must run even when BlockUser committed but
// the request's own state transition afterward lost a race (409) — the user
// is blocked either way, and must not keep a live voice session because of
// it.
func TestDMRequestHandler_Block_EvictsEvenWhenTransitionLosesRace(t *testing.T) {
	database := newDMTestDB(t)
	senderID, _, channelID, _, recipientTok := seedOneToOneDM(t, database, "alice", "bob")
	svc0 := service.New(database, auth.NewRateLimiter())
	sendResult, err := svc0.Messages.SendMessage(context.Background(), service.SendMessageParams{
		ChannelID: channelID, UserID: senderID, Username: "alice", Content: "hi bob",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	reqID := sendResult.RequestCreatedFor[0].ID

	bc := &watermarkVoiceBroadcaster{mockBroadcaster: &mockBroadcaster{}}
	store := &raceAfterBlockStore{DB: database, requestID: reqID}
	svc := service.New(store, auth.NewRateLimiter())
	r := chi.NewRouter()
	api.MountDMRequestRoutes(r, svc, bc)

	rr := dmPost(t, r, fmt.Sprintf("/api/v1/dm-requests/%d/block", reqID), recipientTok, map[string]any{})
	if rr.Code != http.StatusConflict {
		t.Fatalf("block = %d, want 409 (the race already decided the row); body=%s", rr.Code, rr.Body.String())
	}

	if len(bc.evictCalls) != 1 || bc.evictCalls[0].userID != senderID || bc.evictCalls[0].channelID != channelID {
		t.Fatalf("DisconnectFromVoiceInChannel calls = %+v, want exactly one for user=%d channel=%d despite the 409",
			bc.evictCalls, senderID, channelID)
	}
	var blocked int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?`, mustUserID(t, database, "bob"), senderID,
	).Scan(&blocked); err != nil || blocked != 1 {
		t.Errorf("user_blocks rows = %d, %v; want 1 (BlockUser committed before the race)", blocked, err)
	}
}

// TestMessageRequest_SenderRESTViewIsByteIdentical: decision 5's property,
// read from the REST surface — GET /api/v1/dms and GET
// /channels/{id}/messages report the same shape for the sender regardless of
// whether the recipient's request ends up pending, ignored, deleted or (the
// control) the pair was already trusted. Only volatile ids/timestamps are
// normalised.
func TestMessageRequest_SenderRESTViewIsByteIdentical(t *testing.T) {
	database := newDMTestDB(t)
	router, svc := buildDMRequestRouter(database, &mockBroadcaster{})
	senderTok := dmCreateToken(t, database, "alice", 4)
	senderID := mustUserID(t, database, "alice")

	type capture struct {
		dms      []byte
		messages []byte
	}
	capture1 := func(recipientName string, preTrust bool, transition func(reqID int64)) capture {
		t.Helper()
		recipientTok := dmCreateToken(t, database, recipientName, 4)
		recipientID := mustUserID(t, database, recipientName)
		ch, _, err := database.GetOrCreateDMChannel(context.Background(), senderID, recipientID)
		if err != nil {
			t.Fatalf("GetOrCreateDMChannel: %v", err)
		}
		if preTrust {
			if err := database.TrustSender(context.Background(), recipientID, senderID, "accepted"); err != nil {
				t.Fatalf("TrustSender: %v", err)
			}
		}
		sendResult, err := svc.Messages.SendMessage(context.Background(), service.SendMessageParams{
			ChannelID: ch.ID, UserID: senderID, Username: "alice", Content: "hello",
		})
		if err != nil {
			t.Fatalf("SendMessage: %v", err)
		}
		if preTrust && len(sendResult.RequestCreatedFor) != 0 {
			t.Fatalf("%s: a trusted recipient must never have a request created, got %v", recipientName, sendResult.RequestCreatedFor)
		}
		if transition != nil {
			if len(sendResult.RequestCreatedFor) != 1 {
				t.Fatalf("%s: RequestCreatedFor = %v, want one", recipientName, sendResult.RequestCreatedFor)
			}
			transition(sendResult.RequestCreatedFor[0].ID)
		}
		_ = recipientTok

		dmsRR := dmGet(t, router, "/api/v1/dms", senderTok)
		if dmsRR.Code != http.StatusOK {
			t.Fatalf("%s: GET /dms = %d", recipientName, dmsRR.Code)
		}
		msgsRR := dmGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages", ch.ID), senderTok)
		if msgsRR.Code != http.StatusOK {
			t.Fatalf("%s: GET messages = %d", recipientName, msgsRR.Code)
		}
		return capture{dms: normalizeDMListForCompare(t, dmsRR.Body.Bytes(), ch.ID), messages: normalizeMessagesForCompare(t, msgsRR.Body.Bytes())}
	}

	pending := capture1("bob", false, nil)
	ignored := capture1("carol", false, func(id int64) {
		if _, err := svc.MessageRequests.Ignore(context.Background(), mustUserID(t, database, "carol"), id); err != nil {
			t.Fatalf("Ignore: %v", err)
		}
	})
	deleted := capture1("dave", false, func(id int64) {
		if _, err := svc.MessageRequests.Delete(context.Background(), mustUserID(t, database, "dave"), id); err != nil {
			t.Fatalf("Delete: %v", err)
		}
	})
	// Trusted control: eve already trusts alice, so no request is ever created.
	trustedControl := capture1("eve", true, nil)

	for name, got := range map[string]capture{"ignored": ignored, "deleted": deleted, "trusted": trustedControl} {
		if !bytes.Equal(got.messages, pending.messages) {
			t.Errorf("%s messages view differs from pending's:\npending: %s\n%s:  %s", name, pending.messages, name, got.messages)
		}
		if !bytes.Equal(got.dms, pending.dms) {
			t.Errorf("%s dm list entry differs from pending's:\npending: %s\n%s:  %s", name, pending.dms, name, got.dms)
		}
	}
}

// dmRecipientCompareFields is a DM recipient with only its two identifiers —
// id and username — dropped, the same way channel_id/last_message_id are
// below: this test deliberately varies WHO the recipient is (bob, carol,
// dave, eve) to prove decision 5's property holds across different people,
// not just different decision states, so the one thing that must differ
// structurally is exactly what an id or a username names. display_name,
// avatar and status are compared, not just dropped — and already agree
// across all four: none of dmCreateToken's users is seeded with a display
// name or avatar, and none holds a live connection, so every one of them
// presents as status "offline".
type dmRecipientCompareFields struct {
	DisplayName string `json:"display_name"`
	Avatar      string `json:"avatar"`
	Status      string `json:"status"`
}

// dmListCompareFields is a GET /dms entry with only ids and timestamps
// dropped (Codex review round 3: the previous version still whitelisted a
// handful of fields, and dropped the whole recipient/recipients object
// rather than normalising it). Dropped:
//   - channel_id, last_message_id: arbitrary per-pair/per-message ids —
//     structurally different across bob/carol/dave/eve's distinct channels.
//   - last_message_at: a timestamp — this test does not fake the clock.
//   - recipient.id/username, recipients[].id/username: see
//     dmRecipientCompareFields.
//
// Everything else — is_group, name, the recipient's remaining fields,
// last_message (content), unread_count, mention_count — is compared.
type dmListCompareFields struct {
	IsGroup      bool                       `json:"is_group"`
	Name         string                     `json:"name"`
	Recipient    dmRecipientCompareFields   `json:"recipient"`
	Recipients   []dmRecipientCompareFields `json:"recipients"`
	LastMessage  string                     `json:"last_message"`
	UnreadCount  int                        `json:"unread_count"`
	MentionCount int                        `json:"mention_count"`
}

// normalizeDMListForCompare extracts dmListCompareFields from the one DM
// entry naming wantChannelID.
func normalizeDMListForCompare(t *testing.T, body []byte, wantChannelID int64) []byte {
	t.Helper()
	var parsed struct {
		DMChannels []map[string]any `json:"dm_channels"`
	}
	// dm_handler.go's GET /dms shape: check both common top-level keys.
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("decode dms: %v; body=%s", err, body)
	}
	var list []map[string]any
	if len(parsed.DMChannels) > 0 {
		list = parsed.DMChannels
	} else {
		var alt []map[string]any
		if err := json.Unmarshal(body, &alt); err == nil {
			list = alt
		}
	}
	for _, entry := range list {
		id, ok := entry["channel_id"].(float64)
		if !ok || int64(id) != wantChannelID {
			continue
		}
		raw, err := json.Marshal(entry)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var fields dmListCompareFields
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatalf("decode compare fields: %v; entry=%s", err, raw)
		}
		out, err := json.Marshal(fields)
		if err != nil {
			t.Fatalf("marshal compare fields: %v", err)
		}
		return out
	}
	t.Fatalf("no dm_channels entry for channel %d in %s", wantChannelID, body)
	return nil
}

// normalizeMessagesForCompare blanks the message id and timestamp fields so
// the comparison is over content, not identity.
func normalizeMessagesForCompare(t *testing.T, body []byte) []byte {
	t.Helper()
	var msgs []map[string]any
	if err := json.Unmarshal(body, &msgs); err != nil {
		var wrapped struct {
			Messages []map[string]any `json:"messages"`
		}
		if err2 := json.Unmarshal(body, &wrapped); err2 != nil {
			t.Fatalf("decode messages: %v / %v; body=%s", err, err2, body)
		}
		msgs = wrapped.Messages
	}
	for _, m := range msgs {
		delete(m, "id")
		delete(m, "timestamp")
		delete(m, "channel_id")
	}
	out, err := json.Marshal(msgs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return out
}
