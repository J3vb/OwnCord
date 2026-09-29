package service

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/logctx"
	"github.com/go-chi/chi/v5/middleware"
)

// The request ID the refused call carries, so the test pins that the cause is
// tied to the request the same way the HTTP request logger is.
const refusedReqID = "req-refusal-test-1"

// newLoggingRegistrationService is newRegistrationService with the default
// logger redirected into a logctx-wrapped buffer — the same enrichment the
// production server installs — so a test can read the refusal-cause line and
// its req_id.
func newLoggingRegistrationService(t *testing.T, mode RegistrationMode) (*AuthService, *bytes.Buffer) {
	t.Helper()
	database := newTestDB(t)
	if err := database.SetSetting(context.Background(), registrationModeKey, string(mode)); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	logs := &bytes.Buffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(logctx.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil), logs
}

// The generic 400 is deliberate, but an operator could not tell the causes
// apart, which turned a dead invite into a suspected regression. Each refusal
// now names its cause at WARN, tied to the request by req_id (logctx), and
// never writes the invite code or the password.
func TestRegister_LogsTheRefusalCause(t *testing.T) {
	ctx := context.Background()

	cases := []struct {
		name   string
		setup  func(t *testing.T, svc *AuthService, owner int64) (inviteCode string)
		want   string
		absent string
	}{
		{
			name: "empty invite in invite mode",
			setup: func(t *testing.T, svc *AuthService, owner int64) string {
				return ""
			},
			want: "invite required",
		},
		{
			name: "invite unknown",
			setup: func(t *testing.T, svc *AuthService, owner int64) string {
				return "deadbeefdeadbeef"
			},
			want: "invite unknown",
		},
		{
			name: "invite revoked",
			setup: func(t *testing.T, svc *AuthService, owner int64) string {
				code, err := svc.st.CreateInvite(ctx, owner, 1, nil)
				if err != nil {
					t.Fatalf("CreateInvite: %v", err)
				}
				if err := svc.st.RevokeInvite(ctx, code); err != nil {
					t.Fatalf("RevokeInvite: %v", err)
				}
				return code
			},
			want: "invite revoked",
		},
		{
			name: "invite exhausted",
			setup: func(t *testing.T, svc *AuthService, owner int64) string {
				code, err := svc.st.CreateInvite(ctx, owner, 1, nil)
				if err != nil {
					t.Fatalf("CreateInvite: %v", err)
				}
				if _, err := svc.Register(ctx, RegisterInput{
					Username: "spent", Password: "securePass1", InviteCode: code, Device: "test", IP: "203.0.113.30",
				}); err != nil {
					t.Fatalf("first redemption: %v", err)
				}
				return code
			},
			want: "invite exhausted",
		},
		{
			name: "invite expired",
			setup: func(t *testing.T, svc *AuthService, owner int64) string {
				past := time.Now().Add(-time.Hour)
				code, err := svc.st.CreateInvite(ctx, owner, 0, &past)
				if err != nil {
					t.Fatalf("CreateInvite: %v", err)
				}
				return code
			},
			want: "invite expired",
		},
		{
			name: "username taken",
			setup: func(t *testing.T, svc *AuthService, owner int64) string {
				code, err := svc.st.CreateInvite(ctx, owner, 0, nil) // unlimited
				if err != nil {
					t.Fatalf("CreateInvite: %v", err)
				}
				if _, err := svc.Register(ctx, RegisterInput{
					Username: "refused-user", Password: "securePass1", InviteCode: code, Device: "test", IP: "203.0.113.31",
				}); err != nil {
					t.Fatalf("first registration: %v", err)
				}
				return code
			},
			want: "username taken",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, logs := newLoggingRegistrationService(t, RegistrationInvite)
			owner, err := svc.st.CreateUser(ctx, "owner", "hash", 1)
			if err != nil {
				t.Fatalf("CreateUser: %v", err)
			}
			code := tc.setup(t, svc, owner)

			logs.Reset()
			const password = "secret-Password9"
			// A real request context carries the chi request ID; logctx, which
			// the production server wraps the default logger in, stamps it as
			// req_id on any ...Context log call.
			reqCtx := context.WithValue(ctx, middleware.RequestIDKey, refusedReqID)
			_, err = svc.Register(reqCtx, RegisterInput{
				Username: "refused-user", Password: password, InviteCode: code, Device: "test", IP: "203.0.113.32",
			})
			if !errors.Is(err, ErrRegistrationRejected) {
				t.Fatalf("err = %v, want the generic refusal", err)
			}

			out := logs.String()
			if !strings.Contains(out, tc.want) {
				t.Errorf("log does not name the cause %q:\n%s", tc.want, out)
			}
			if !strings.Contains(out, "req_id="+refusedReqID) {
				t.Errorf("log is not tied to the request id:\n%s", out)
			}
			if code != "" && strings.Contains(out, code) {
				t.Errorf("log leaked the invite code:\n%s", out)
			}
			if strings.Contains(out, password) {
				t.Errorf("log leaked the password:\n%s", out)
			}
		})
	}
}

// failingInviteReadStore fails exactly the invite read-back.
type failingInviteReadStore struct {
	Store
}

func (failingInviteReadStore) GetInvite(context.Context, string) (*db.Invite, error) {
	return nil, errors.New("simulated invite read failure")
}

// A store fault on the read-back must not be logged as a dead invite.
func TestRegister_InviteReadBackFaultIsItsOwnCause(t *testing.T) {
	svc, logs := newLoggingRegistrationService(t, RegistrationInvite)
	svc = NewAuthService(failingInviteReadStore{Store: svc.st}, auth.NewRateLimiter(), make([]byte, 32), nil)

	logs.Reset()
	_, err := svc.Register(context.Background(), RegisterInput{
		Username: "refused-user", Password: "securePass1", InviteCode: "deadbeefdeadbeef", Device: "test", IP: "203.0.113.33",
	})
	if !errors.Is(err, ErrRegistrationRejected) {
		t.Fatalf("err = %v, want the generic refusal", err)
	}
	out := logs.String()
	if !strings.Contains(out, "invite lookup failed") || !strings.Contains(out, "simulated invite read failure") {
		t.Errorf("log does not name the lookup fault:\n%s", out)
	}
	if strings.Contains(out, "invite unknown") {
		t.Errorf("a lookup fault was logged as an unknown invite:\n%s", out)
	}
}
