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
	"sync"
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
	rr := serveLocal(router, req)
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
	api.MountProfileRoutes(router, service.New(database, limiter), nil, limiter, nil, nil, nil)
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

// putPasswordFrom sends a change-password request from its own address, so the per-address
// limit never decides the outcome of a test about the per-account budget.
func putPasswordFrom(router http.Handler, token, addr, oldPassword string) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(map[string]string{"old_password": oldPassword, "new_password": "newSecure2"})
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "/api/v1/users/me/password", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = addr + ":4000"
	return serveRequest(router, req)
}

func TestChangePassword_BurstOfWrongPasswordsIsCapped(t *testing.T) {
	const attempts = 12
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	limiter.SetAdmissionBudget(attempts)
	router := chi.NewRouter()
	api.MountProfileRoutes(router, service.New(database, limiter), nil, limiter, nil, nil, nil)
	token := profileCreateToken(t, database, "budgeted", 4)

	codes := make([]int, attempts)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range attempts {
		wg.Go(func() {
			<-start
			codes[i] = putPasswordFrom(router, token, "203.0.113."+strconv.Itoa(10+i), "wrongPass9").Code
		})
	}
	close(start)
	wg.Wait()

	compared := 0
	for _, c := range codes {
		if c == http.StatusForbidden {
			compared++
		}
	}
	// Three failures plus the one that trips the lockout, as a sequential guesser gets.
	if want := service.PwConfirmFailureThreshold + 1; compared > want {
		t.Fatalf("%d compares ran in one burst, want at most %d (codes %v)", compared, want, codes)
	}
}

// A request refused because the budget is full ran no compare, so it must not use up the
// account's attempts: after many such refusals the right password still goes through.
func TestChangePassword_BusyRefusalsDoNotCountAsAttempts(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	limiter.SetAdmissionBudget(1)
	router := chi.NewRouter()
	api.MountProfileRoutes(router, service.New(database, limiter), nil, limiter, nil, nil, nil)
	token := profileCreateToken(t, database, "refused", 4)
	user, err := database.GetUserByUsername(context.Background(), "refused")
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	release, ok := limiter.Admission().TryAcquire()
	if !ok {
		t.Fatal("could not take the budget's only slot")
	}

	for i := range 8 {
		rr := putPasswordFrom(router, token, "203.0.113."+strconv.Itoa(50+i), "wrongPass9")
		wantErr(t, rr, http.StatusTooManyRequests, "AUTH_BUSY", authBusyMessage)
	}
	release()

	if rr := putPasswordFrom(router, token, "203.0.113.99", "securePass1"); rr.Code != http.StatusNoContent {
		t.Fatalf("correct password after the refusals: status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
	if limiter.IsLockedOut(auth.Key("pw_confirm_lock", user.ID)) {
		t.Fatal("password-confirmation lock set by refusals that ran no compare")
	}
}
