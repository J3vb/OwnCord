package api_test

// The interaction between #2049's batched session touches (service.ConnWrites,
// P5-S07) and sign-out-everywhere: the request's own auth middleware queues a
// touch in memory, and the revoke must still delete the session, take the API
// tokens and drop the live socket in that same request, with the later flush
// unable to bring the session back.

import (
	"context"
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// A touch queued by the request's own auth middleware, still pending when the
// revoke commits, must not resurrect the deleted session when its batch
// lands, and the revoke must still take the API tokens and drop the live
// socket in that request.
func TestSignOutEverywhere_BeatsAQueuedSessionTouch(t *testing.T) {
	ctx := context.Background()
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	batch := svc.BatchConnWrites()
	spy := &revokeSpy{}
	r := chi.NewRouter()
	api.MountProfileRoutes(r, database, svc, nil, limiter, nil, spy, nil)

	token := profileCreateToken(t, database, "alice-batch", 4)
	alice, _ := database.GetUserByUsername(ctx, "alice-batch")
	apiToken := issueAPIToken(t, database, alice.ID)
	hash := auth.HashToken(token)

	// The auth middleware queues this request's session touch instead of
	// writing it, so it is still pending when the handler revokes.
	if rr := profileDelete(t, r, "/api/v1/users/me/sessions", token); rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	// The delete has committed; the queued touch now lands.
	if err := batch.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	if sess, err := database.GetSessionByTokenHash(ctx, hash); err != nil || sess != nil {
		t.Fatalf("session after the flush = %v, %v; a queued touch revived a revoked session", sess, err)
	}
	if rr := getWithToken(t, r, "/api/v1/users/me/sessions", apiToken); rr.Code != http.StatusUnauthorized {
		t.Fatalf("API token after sign-out-everywhere = %d, want 401", rr.Code)
	}
	if len(spy.disconnected) != 1 || spy.disconnected[0] != alice.ID {
		t.Fatalf("disconnected = %v, want [%d]", spy.disconnected, alice.ID)
	}
}
