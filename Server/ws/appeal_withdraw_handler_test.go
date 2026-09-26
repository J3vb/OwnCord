package ws_test

// N3 (round 3 test-strengthening ask): one HANDLER-level test that the real
// POST /api/v1/appeals/{id}/withdraw route — not a direct
// hub.BroadcastAppealQueue call — results in a connected moderator
// receiving the mod_queue "withdrawn" frame while the appellant (who also
// holds MODERATE_MEMBERS here, to make the exclusion meaningful) does not.
// Lives in ws_test (not api_test) because it needs a REAL hub with REAL
// sockets to observe both the broadcast and F5's audience exclusion
// together; a recording fake broadcaster (the api_test pattern) would only
// prove the call happened, not who it actually reaches.

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
)

func TestHandleWithdrawAppeal_BroadcastsToModeratorNotToAppellant(t *testing.T) {
	database := openReportTestDB(t)
	ctx := context.Background()

	// The appellant independently holds MODERATE_MEMBERS (role 3), so the
	// exclusion this test pins is F5's appellant rule, not a plain member's
	// lack of the bit.
	appellantID, err := database.CreateUser(ctx, "wh-appellant-mod", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser(appellant): %v", err)
	}
	actingModID, err := database.CreateUser(ctx, "wh-acting-mod", "hash", 1) // Owner: outranks role 3
	if err != nil {
		t.Fatalf("CreateUser(acting mod): %v", err)
	}
	otherModID, err := database.CreateUser(ctx, "wh-other-mod", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser(other mod): %v", err)
	}

	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHubDeps(t, database, limiter, svc)
	// Mirrors api/router.go's wireAuth: both the appeal_status notifier and
	// the mod_queue broadcaster are wired to the same hub.
	svc.Appeals.SetNotifier(hub)
	svc.Appeals.SetQueueBroadcaster(hub)
	go hub.Run()
	defer hub.Stop()

	appellantSend := make(chan []byte, 8)
	otherModSend := make(chan []byte, 8)
	appellantClient := ws.NewTestClient(hub, appellantID, appellantSend)
	otherModClient := ws.NewTestClient(hub, otherModID, otherModSend)
	hub.Register(appellantClient)
	hub.Register(otherModClient)
	waitRegistered(t, hub, appellantClient)
	waitRegistered(t, hub, otherModClient)

	r := chi.NewRouter()
	api.MountAppealRoutes(r, svc)
	api.MountModerationAppealRoutes(r, svc)

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, appellantID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	actionID, err := database.WarnUser(ctx, appellantID, actingModID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	publicID, err := svc.Appeals.Submit(ctx, appellantID, actionID, "please reconsider")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	// Drain Submit's own "open" mod_queue frame so it doesn't contaminate
	// the withdraw assertion below.
	drainChanTimeout(otherModSend, 100*time.Millisecond)
	drainChanTimeout(appellantSend, 100*time.Millisecond)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/appeals/"+publicID+"/withdraw", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("POST withdraw: status = %d, body = %s, want 204", rec.Code, rec.Body.String())
	}

	want := []byte(`{"type":"mod_queue","payload":{"appeal_id":"` + publicID + `","state":"withdrawn"}}`)
	assertReceived(t, otherModSend, want, "the uninvolved moderator")

	// The appellant DOES legitimately receive their own appeal_status
	// frame (decision 8) — drain it — but must NEVER receive the mod_queue
	// frame about their own appeal (F5), which is the property this test
	// pins.
	appellantMsgs := drainChanTimeout(appellantSend, 200*time.Millisecond)
	for _, msg := range appellantMsgs {
		if bytes.Contains(msg, []byte(`"type":"mod_queue"`)) {
			t.Fatalf("the appellant (also a moderator) received a mod_queue frame about their own appeal: %s", msg)
		}
	}
}
