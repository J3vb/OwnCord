package api_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

const (
	appealContactLine = "Email owner@example.test or ask in the public forum"
	plainBanRefusal   = `{"error":"FORBIDDEN","message":"your account has been suspended"}`
)

// failingAppealStore makes the appeal_contact read fail the way a broken settings table would.
type failingAppealStore struct{ *db.DB }

func (s failingAppealStore) GetSetting(ctx context.Context, key string) (string, error) {
	if key == service.AppealContactKey {
		return "", errors.New("settings unavailable")
	}
	return s.DB.GetSetting(ctx, key)
}

func banUser(t *testing.T, database *db.DB, id int64) {
	t.Helper()
	if err := database.BanUser(context.Background(), id, "rules", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
}

func TestLoginBanned_AppealContact(t *testing.T) {
	database, _, router := newAuthEnv(t)
	banUser(t, database, seedUser(t, database, "banned", "correctPass1", 4))

	// Nothing set: the body is the plain refusal, byte for byte.
	rr := postLogin(t, router, "banned", "correctPass1")
	requireStatus(t, rr, http.StatusForbidden)
	if got := strings.TrimSpace(rr.Body.String()); got != plainBanRefusal {
		t.Fatalf("body = %s, want %s", got, plainBanRefusal)
	}

	setSetting(t, database, service.AppealContactKey, "  "+appealContactLine+" ")
	rr = postLogin(t, router, "banned", "correctPass1")
	requireStatus(t, rr, http.StatusForbidden)
	body := decodeBody[map[string]string](t, rr)
	if body["appeal_contact"] != appealContactLine || body["message"] != "your account has been suspended" || body["error"] != "FORBIDDEN" {
		t.Fatalf("body = %v", body)
	}
}

func TestLoginBanned_AppealContactReadFailsRefusesPlainly(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	r := chi.NewRouter()
	svc := service.NewAuthService(failingAppealStore{database}, limiter, testTOTPKey, nil)
	api.MountAuthRoutes(r, svc, api.AuthMiddleware(service.NewSessionService(database)), limiter, nil)

	id := seedUser(t, database, "banned", "correctPass1", 4)
	banUser(t, database, id)
	setSetting(t, database, service.AppealContactKey, appealContactLine)

	rr := postLogin(t, r, "banned", "correctPass1")
	requireStatus(t, rr, http.StatusForbidden)
	if got := strings.TrimSpace(rr.Body.String()); got != plainBanRefusal {
		t.Fatalf("body = %s, want %s", got, plainBanRefusal)
	}
	var sessions int
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, id).Scan(&sessions); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if sessions != 0 {
		t.Fatalf("sessions = %d, want 0", sessions)
	}
}

func TestLoginRefusals_CarryNoAppealContact(t *testing.T) {
	database, _, router := newAuthEnv(t)
	setSetting(t, database, service.AppealContactKey, appealContactLine)

	banUser(t, database, seedUser(t, database, "banned", "correctPass1", 4))
	hash, err := auth.HashPassword("correctPass1")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if _, err := database.CreatePendingUser(context.Background(), "waiting", hash, 4, 100); err != nil {
		t.Fatalf("CreatePendingUser: %v", err)
	}

	cases := []struct {
		name, user, pass string
		status           int
	}{
		{"banned account, wrong password", "banned", "wrongPassword1", http.StatusUnauthorized},
		{"unknown account", "nobody", "wrongPassword1", http.StatusUnauthorized},
		{"pending approval", "waiting", "correctPass1", http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr := postLogin(t, router, tc.user, tc.pass)
			requireStatus(t, rr, tc.status)
			if strings.Contains(rr.Body.String(), "appeal_contact") || strings.Contains(rr.Body.String(), "owner@example.test") {
				t.Fatalf("refusal leaked the appeal contact: %s", rr.Body.String())
			}
		})
	}
}

// An account whose deletion is in progress gets the same 403 as a ban but never the appeal contact: there is
// nothing left to appeal.
func TestLoginErasingAccount_NoAppealContact(t *testing.T) {
	database := openMigratedDB(t)
	router := buildAuthRouter(database, auth.NewRateLimiter())
	seedUser(t, database, "keeper", "correctPass1", 1)
	id := seedUser(t, database, "leaving", "correctPass1", 4)
	setSetting(t, database, service.AppealContactKey, appealContactLine)
	if _, err := database.EraseAccountLock(context.Background(), id, true); err != nil {
		t.Fatalf("EraseAccountLock: %v", err)
	}

	rr := postLogin(t, router, "leaving", "correctPass1")
	requireStatus(t, rr, http.StatusForbidden)
	if got := strings.TrimSpace(rr.Body.String()); got != plainBanRefusal {
		t.Fatalf("body = %s, want %s", got, plainBanRefusal)
	}
}

func TestVerifyTOTPBanned_AppealContact(t *testing.T) {
	database, _, router := newAuthEnv(t)
	partial := loginAwaitingTOTP(t, database, router, "totpbanned", "JBSWY3DPEHPK3PXP")
	var id int64
	if err := database.QueryRowContext(context.Background(), `SELECT id FROM users WHERE username = ?`, "totpbanned").Scan(&id); err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	banUser(t, database, id)
	setSetting(t, database, service.AppealContactKey, appealContactLine)

	rr := postJSONWithToken(t, router, "/api/v1/auth/verify-totp", partial, map[string]string{"code": "000000"})
	requireStatus(t, rr, http.StatusForbidden)
	if got := decodeBody[map[string]string](t, rr)["appeal_contact"]; got != appealContactLine {
		t.Fatalf("appeal_contact = %q", got)
	}
}
