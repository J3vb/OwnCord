package api_test

// nsfw_handler_test.go covers the B5-7 REST surface
// (/api/v1/channels/{id}/nsfw-acknowledgement): visibility and label
// preconditions, idempotency, and the second-device nsfw_ack signal.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

func newNSFWTestDB(t *testing.T) *db.DB {
	t.Helper()
	return openMigratedDB(t)
}

func buildNSFWRouter(database *db.DB, broadcaster api.DMBroadcaster) http.Handler {
	r := chi.NewRouter()
	svc := service.New(database, auth.NewRateLimiter())
	api.MountNSFWRoutes(r, svc, broadcaster)
	return r
}

func nsfwDo(t *testing.T, router http.Handler, method, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	return doAPI(t, router, method, path, token, nil)
}

func nsfwSetLabel(t *testing.T, database *db.DB, channelID int64, nsfw bool) {
	t.Helper()
	v := 0
	if nsfw {
		v = 1
	}
	if _, err := database.ExecContext(context.Background(),
		`UPDATE channels SET nsfw = ? WHERE id = ?`, v, channelID); err != nil {
		t.Fatalf("nsfwSetLabel: %v", err)
	}
}

func nsfwPath(channelID int64) string {
	return "/api/v1/channels/" + strconv.FormatInt(channelID, 10) + "/nsfw-acknowledgement"
}

func TestNSFW_AcknowledgeRequiresVisibilityAndALabel(t *testing.T) {
	database := newNSFWTestDB(t)
	router := buildNSFWRouter(database, &mockBroadcaster{})
	userID := mintUser(t, database, "acker")
	token, _ := mintSession(t, database, userID)

	// Invisible channel: deny READ_MESSAGES for the caller's role.
	hiddenID := mustCreateChannel(t, database, "hidden", "text")
	if err := database.UpsertChannelOverride(context.Background(), hiddenID, permissions.MemberRoleID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
	if rr := nsfwDo(t, router, http.MethodPut, nsfwPath(hiddenID), token); rr.Code != http.StatusNotFound {
		t.Errorf("PUT on invisible channel = %d, want 404; body %s", rr.Code, rr.Body.String())
	}

	// Visible but not labelled.
	plainID := mustCreateChannel(t, database, "plain", "text")
	rr := nsfwDo(t, router, http.MethodPut, nsfwPath(plainID), token)
	expectStatus(t, rr, http.StatusConflict)
	body := decodeBody[struct {
		Error string `json:"error"`
	}](t, rr)
	if body.Error != "NOT_NSFW" {
		t.Errorf("error code = %q, want NOT_NSFW", body.Error)
	}

	// Visible and labelled: 204, twice (idempotent).
	labelledID := mustCreateChannel(t, database, "labelled", "text")
	nsfwSetLabel(t, database, labelledID, true)
	for i := range 2 {
		if rr := nsfwDo(t, router, http.MethodPut, nsfwPath(labelledID), token); rr.Code != http.StatusNoContent {
			t.Errorf("PUT #%d on labelled channel = %d, want 204; body %s", i, rr.Code, rr.Body.String())
		}
	}
	ok, err := database.HasNSFWAcknowledgement(context.Background(), userID, labelledID)
	if err != nil || !ok {
		t.Fatalf("HasNSFWAcknowledgement after PUT = (%v, %v), want (true, nil)", ok, err)
	}
}

func TestNSFW_Unauthenticated(t *testing.T) {
	database := newNSFWTestDB(t)
	router := buildNSFWRouter(database, &mockBroadcaster{})
	chID := mustCreateChannel(t, database, "any", "text")
	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		if rr := nsfwDo(t, router, method, nsfwPath(chID), ""); rr.Code != http.StatusUnauthorized {
			t.Errorf("%s unauthenticated = %d, want 401", method, rr.Code)
		}
	}
}

// TestNSFW_RevokeTakesEffectOnTheNextRead: no restart, no reconnect — the
// very next HasNSFWAcknowledgement read after DELETE sees it gone.
func TestNSFW_RevokeTakesEffectOnTheNextRead(t *testing.T) {
	database := newNSFWTestDB(t)
	router := buildNSFWRouter(database, &mockBroadcaster{})
	userID := mintUser(t, database, "revoker")
	token, _ := mintSession(t, database, userID)

	chID := mustCreateChannel(t, database, "labelled", "text")
	nsfwSetLabel(t, database, chID, true)

	if rr := nsfwDo(t, router, http.MethodPut, nsfwPath(chID), token); rr.Code != http.StatusNoContent {
		t.Fatalf("PUT = %d, want 204; body %s", rr.Code, rr.Body.String())
	}
	if ok, err := database.HasNSFWAcknowledgement(context.Background(), userID, chID); err != nil || !ok {
		t.Fatalf("HasNSFWAcknowledgement after PUT = (%v, %v), want (true, nil)", ok, err)
	}

	if rr := nsfwDo(t, router, http.MethodDelete, nsfwPath(chID), token); rr.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d, want 204; body %s", rr.Code, rr.Body.String())
	}
	if ok, err := database.HasNSFWAcknowledgement(context.Background(), userID, chID); err != nil || ok {
		t.Fatalf("HasNSFWAcknowledgement after DELETE = (%v, %v), want (false, nil)", ok, err)
	}

	// Idempotent: revoking again (nothing left to revoke) still 204.
	if rr := nsfwDo(t, router, http.MethodDelete, nsfwPath(chID), token); rr.Code != http.StatusNoContent {
		t.Errorf("second DELETE = %d, want 204; body %s", rr.Code, rr.Body.String())
	}
}

// TestNSFW_SecondDeviceGetsTheSignal proves acknowledge/revoke send the
// caller's OTHER live sockets an nsfw_ack frame carrying the new state.
func TestNSFW_SecondDeviceGetsTheSignal(t *testing.T) {
	database := newNSFWTestDB(t)
	bc := &mockBroadcaster{}
	router := buildNSFWRouter(database, bc)
	userID := mintUser(t, database, "twodevice")
	token, _ := mintSession(t, database, userID)

	chID := mustCreateChannel(t, database, "labelled", "text")
	nsfwSetLabel(t, database, chID, true)

	if rr := nsfwDo(t, router, http.MethodPut, nsfwPath(chID), token); rr.Code != http.StatusNoContent {
		t.Fatalf("PUT = %d, want 204", rr.Code)
	}
	if len(bc.sent) != 1 || bc.sent[0].UserID != userID {
		t.Fatalf("nsfw_ack sent = %+v, want exactly one to %d", bc.sent, userID)
	}
	var frame struct {
		Type    string `json:"type"`
		Payload struct {
			ChannelID    int64 `json:"channel_id"`
			Acknowledged bool  `json:"acknowledged"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(bc.sent[0].Msg, &frame); err != nil {
		t.Fatalf("decode nsfw_ack: %v", err)
	}
	if frame.Type != "nsfw_ack" || frame.Payload.ChannelID != chID || !frame.Payload.Acknowledged {
		t.Errorf("nsfw_ack frame = %+v, want type=nsfw_ack channel_id=%d acknowledged=true", frame, chID)
	}

	if rr := nsfwDo(t, router, http.MethodDelete, nsfwPath(chID), token); rr.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d, want 204", rr.Code)
	}
	if len(bc.sent) != 2 {
		t.Fatalf("nsfw_ack sent = %d frames, want 2", len(bc.sent))
	}
	if err := json.Unmarshal(bc.sent[1].Msg, &frame); err != nil {
		t.Fatalf("decode second nsfw_ack: %v", err)
	}
	if frame.Payload.Acknowledged {
		t.Errorf("revoke's nsfw_ack frame acknowledged = true, want false")
	}
}

// TestNSFW_AcknowledgeAndRevokeBumpVisibilityWatermark is P2-8: nsfw_ack is
// unsequenced and not replayed, so a frame dropped by a disconnected socket
// is gone for good unless something else forces a resync. Both endpoints
// must bump the visibility watermark exactly like dm_channel_open does
// (markDMVisibilityChanged), so a later warm resume is forced onto the
// full-ready path and comes back with the authoritative nsfw_acknowledged
// state even when the frame itself was missed entirely.
func TestNSFW_AcknowledgeAndRevokeBumpVisibilityWatermark(t *testing.T) {
	database := newNSFWTestDB(t)
	bc := &watermarkVoiceBroadcaster{mockBroadcaster: &mockBroadcaster{}}
	router := buildNSFWRouter(database, bc)
	userID := mintUser(t, database, "watermark-user")
	token, _ := mintSession(t, database, userID)

	chID := mustCreateChannel(t, database, "labelled", "text")
	nsfwSetLabel(t, database, chID, true)

	if rr := nsfwDo(t, router, http.MethodPut, nsfwPath(chID), token); rr.Code != http.StatusNoContent {
		t.Fatalf("PUT = %d, want 204; body %s", rr.Code, rr.Body.String())
	}
	if bc.markCalls < 1 {
		t.Fatalf("MarkVisibilityChanged calls after acknowledge = %d, want at least 1", bc.markCalls)
	}

	acksAfterPut := bc.markCalls
	if rr := nsfwDo(t, router, http.MethodDelete, nsfwPath(chID), token); rr.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d, want 204; body %s", rr.Code, rr.Body.String())
	}
	if bc.markCalls <= acksAfterPut {
		t.Fatalf("MarkVisibilityChanged calls after revoke = %d, want more than %d", bc.markCalls, acksAfterPut)
	}
}
