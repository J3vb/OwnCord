package api_test

// B4-4 (SEC-01): the transport answers an admission refusal with 429 on the
// login route the auth slice owns and on the change-password route the
// profile handler owns, since both take the same budget. The code is
// AUTH_BUSY, distinct from the per-IP RATE_LIMITED, and a login refused from
// the queue carries Retry-After (P5-S02).

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

const authBusyMessage = "too many authentication attempts in progress, try again later"

func TestLogin_RefusedWhenAuthBudgetExhausted(t *testing.T) {
	database := newAuthTestDB(t)
	seedUser(t, database, "budgeted", "securePass1", 4)
	limiter := auth.NewRateLimiter()
	limiter.SetAdmissionBudget(1)
	release, ok := limiter.Admission().TryAcquire()
	if !ok {
		t.Fatal("could not take the budget's only slot")
	}
	router := buildAuthRouter(database, limiter)
	body := map[string]string{"username": "budgeted", "password": "securePass1"}

	// Login queues for the slot, so it is refused only once the caller gives
	// up — here, when the request's context ends.
	raw, _ := json.Marshal(body)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/v1/auth/login", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	wantErr(t, rr, http.StatusTooManyRequests, "AUTH_BUSY", authBusyMessage)
	if secs, err := strconv.Atoi(rr.Header().Get("Retry-After")); err != nil || secs < 1 {
		t.Fatalf("Retry-After = %q, want a positive number of seconds", rr.Header().Get("Retry-After"))
	}

	// A login queued behind the held slot succeeds once it comes back.
	time.AfterFunc(100*time.Millisecond, release)
	if rr := postJSON(t, router, "/api/v1/auth/login", body); rr.Code != http.StatusOK {
		t.Fatalf("queued login: status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
}

func TestChangePassword_RefusedWhenAuthBudgetExhausted(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	limiter.SetAdmissionBudget(1)
	router := chi.NewRouter()
	api.MountProfileRoutes(router, database, service.New(database, limiter), nil, limiter, nil, nil)
	token := profileCreateToken(t, database, "budgeted", 4)
	release, ok := limiter.Admission().TryAcquire()
	if !ok {
		t.Fatal("could not take the budget's only slot")
	}
	body := map[string]string{"old_password": "securePass1", "new_password": "newSecure2"}

	wantErr(t, putJSON(t, router, "/api/v1/users/me/password", token, body), http.StatusTooManyRequests, "AUTH_BUSY", authBusyMessage)

	release()
	if rr := putJSON(t, router, "/api/v1/users/me/password", token, body); rr.Code != http.StatusNoContent {
		t.Fatalf("password change after release: status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
}
