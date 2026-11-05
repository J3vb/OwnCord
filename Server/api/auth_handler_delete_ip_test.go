package api_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// deleteIPRecorder is the real auth service with DeleteAccount replaced by a
// recorder, so the test sees the IP the handler hands the service.
type deleteIPRecorder struct {
	*service.AuthService
	gotIP string
}

func (d *deleteIPRecorder) DeleteAccount(_ context.Context, _ service.Principal, _, ip string) error {
	d.gotIP = ip
	return nil
}

// Behind a trusted reverse proxy the account-deletion record must name the
// forwarded client, exactly as login and register do, not the proxy hop.
func TestDeleteAccount_ResolvesClientIPThroughTrustedProxy(t *testing.T) {
	cases := []struct {
		name    string
		trusted []string
		want    string
	}{
		{"trusted proxy", []string{"10.0.0.0/8"}, "203.0.113.7"},
		{"untrusted proxy", nil, "10.0.0.1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			database := newMigratedAuthTestDB(t)
			limiter := auth.NewRateLimiter()
			rec := &deleteIPRecorder{AuthService: service.NewAuthService(database, limiter, testTOTPKey, nil)}

			r := chi.NewRouter()
			api.MountAuthRoutes(r, rec, api.AuthMiddleware(service.NewSessionService(database)), limiter, tc.trusted)

			uid := seedUser(t, database, "deleteip", "correctPass1", 4)
			token, _ := auth.GenerateToken()
			_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "10.0.0.1")

			req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/account", bytes.NewReader([]byte(`{"password":"correctPass1"}`)))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("X-Forwarded-For", "203.0.113.7")
			req.RemoteAddr = "10.0.0.1:4000"
			rr := serveRequest(r, req)

			requireStatus(t, rr, http.StatusNoContent)
			if rec.gotIP != tc.want {
				t.Fatalf("DeleteAccount ip = %q, want %q", rec.gotIP, tc.want)
			}
		})
	}
}
