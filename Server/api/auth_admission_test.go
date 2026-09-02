package api_test

// B4-4 (SEC-01): the transport answers an admission refusal with the
// existing rate-limit shape — 429 RATE_LIMITED — on the login route the auth
// slice owns and on the change-password route the profile handler owns,
// since both take the same budget.

import (
	"net/http"
	"testing"

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

	wantErr(t, postJSON(t, router, "/api/v1/auth/login", body), http.StatusTooManyRequests, "RATE_LIMITED", authBusyMessage)

	release()
	if rr := postJSON(t, router, "/api/v1/auth/login", body); rr.Code != http.StatusOK {
		t.Fatalf("login after release: status = %d, want 200; body = %s", rr.Code, rr.Body.String())
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

	wantErr(t, putJSON(t, router, "/api/v1/users/me/password", token, body), http.StatusTooManyRequests, "RATE_LIMITED", authBusyMessage)

	release()
	if rr := putJSON(t, router, "/api/v1/users/me/password", token, body); rr.Code != http.StatusNoContent {
		t.Fatalf("password change after release: status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
}
