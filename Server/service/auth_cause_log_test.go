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
)

// authFaultStore fails the named store calls with the injected error and
// delegates the rest to the real database. Keys are method names; GetSetting
// is keyed per setting as "GetSetting:<key>".
type authFaultStore struct {
	*db.DB
	fail map[string]error
}

func (f *authFaultStore) GetSetting(ctx context.Context, key string) (string, error) {
	if err := f.fail["GetSetting:"+key]; err != nil {
		return "", err
	}
	return f.DB.GetSetting(ctx, key)
}

func (f *authFaultStore) CountPendingUsers(ctx context.Context) (int64, error) {
	if err := f.fail["CountPendingUsers"]; err != nil {
		return 0, err
	}
	return f.DB.CountPendingUsers(ctx)
}

func (f *authFaultStore) CreateSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error) {
	if err := f.fail["CreateSession"]; err != nil {
		return 0, err
	}
	return f.DB.CreateSession(ctx, userID, tokenHash, device, ip)
}

func (f *authFaultStore) DeleteSession(ctx context.Context, tokenHash string) error {
	if err := f.fail["DeleteSession"]; err != nil {
		return err
	}
	return f.DB.DeleteSession(ctx, tokenHash)
}

func (f *authFaultStore) UpdateUserTOTPSecret(ctx context.Context, id int64, secret *string) error {
	if err := f.fail["UpdateUserTOTPSecret"]; err != nil {
		return err
	}
	return f.DB.UpdateUserTOTPSecret(ctx, id, secret)
}

func (f *authFaultStore) GetRecoveryKit(ctx context.Context, userID int64) (*db.RecoveryKit, error) {
	if err := f.fail["GetRecoveryKit"]; err != nil {
		return nil, err
	}
	return f.DB.GetRecoveryKit(ctx, userID)
}

func (f *authFaultStore) GetUserByID(ctx context.Context, id int64) (*db.User, error) {
	if err := f.fail["GetUserByID"]; err != nil {
		return nil, err
	}
	return f.DB.GetUserByID(ctx, id)
}

const (
	causeLogUser     = "causeuser"
	causeLogPassword = "Cause-Log-Pass1!"
	causeLogIP       = "203.0.113.9"
)

// authCauseFixture is one account over a faulting store, plus the captured
// log. Nothing is armed yet: a case sets st.fail after its setup.
type authCauseFixture struct {
	svc  *AuthService
	st   *authFaultStore
	user *db.User
	logs *bytes.Buffer
}

func newAuthCauseFixture(t *testing.T) *authCauseFixture {
	t.Helper()
	ctx := context.Background()
	database := newTestDB(t)
	hash, err := auth.HashPassword(causeLogPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	uid, err := database.CreateUser(ctx, causeLogUser, hash, 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByID(ctx, uid)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	logs := &bytes.Buffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	st := &authFaultStore{DB: database, fail: map[string]error{}}
	return &authCauseFixture{
		svc:  NewAuthService(st, auth.NewRateLimiter(), make([]byte, 32), nil),
		st:   st,
		user: user,
		logs: logs,
	}
}

// A refusal that hides its cause from the client must log it: the sentinel
// returned stays exactly as it was, and one error record carries the cause —
// the error only, never the username, address or password of the request.
func TestAuthRefusals_LogTheCauseOnce(t *testing.T) {
	ctx := context.Background()
	cause := errors.New("database is locked")

	cases := []struct {
		name string
		// fail arms the store call that returns cause once setup is done.
		fail string
		// late: the case arms the fault itself, after its own setup.
		late bool
		want error
		run  func(t *testing.T, f *authCauseFixture) error
	}{
		{"registration_policy_mode", "GetSetting:registration_mode", false, ErrRegistrationPolicyUnavailable,
			func(t *testing.T, f *authCauseFixture) error { return f.svc.RegistrationPolicy(ctx) }},
		{"registration_policy_2fa", "GetSetting:require_2fa", false, ErrRegistrationPolicyUnavailable,
			func(t *testing.T, f *authCauseFixture) error { return f.svc.RegistrationPolicy(ctx) }},
		{"register_mode", "GetSetting:registration_mode", false, ErrRegistrationPolicyUnavailable,
			func(t *testing.T, f *authCauseFixture) error {
				_, err := f.svc.Register(ctx, RegisterInput{Username: "newbie", Password: causeLogPassword, IP: causeLogIP})
				return err
			}},
		{"register_pending_count", "CountPendingUsers", false, ErrRegistrationPolicyUnavailable,
			func(t *testing.T, f *authCauseFixture) error {
				if err := f.st.SetSetting(ctx, registrationModeKey, string(RegistrationApproval)); err != nil {
					t.Fatalf("SetSetting: %v", err)
				}
				_, err := f.svc.Register(ctx, RegisterInput{Username: "newbie", Password: causeLogPassword, IP: causeLogIP})
				return err
			}},
		{"login_policy", "GetSetting:require_2fa", false, ErrAuthPolicyUnavailable,
			func(t *testing.T, f *authCauseFixture) error {
				_, err := f.svc.Login(ctx, LoginInput{Username: causeLogUser, Password: causeLogPassword, Device: "dev", IP: causeLogIP})
				return err
			}},
		{"login_session", "CreateSession", false, ErrSessionIssue,
			func(t *testing.T, f *authCauseFixture) error {
				_, err := f.svc.Login(ctx, LoginInput{Username: causeLogUser, Password: causeLogPassword, Device: "dev", IP: causeLogIP})
				return err
			}},
		{"verify_totp_session", "CreateSession", false, ErrSessionIssue,
			func(t *testing.T, f *authCauseFixture) error {
				secret, err := auth.GenerateTOTPSecret()
				if err != nil {
					t.Fatalf("GenerateTOTPSecret: %v", err)
				}
				key := make([]byte, 32)
				enc, err := auth.EncryptTOTPSecret(key, secret)
				if err != nil {
					t.Fatalf("EncryptTOTPSecret: %v", err)
				}
				if err := f.st.DB.UpdateUserTOTPSecret(ctx, f.user.ID, &enc); err != nil {
					t.Fatalf("UpdateUserTOTPSecret: %v", err)
				}
				token, err := f.svc.partial.Issue(ctx, f.user.ID, "dev", causeLogIP)
				if err != nil {
					t.Fatalf("Issue: %v", err)
				}
				code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
				if err != nil {
					t.Fatalf("GenerateTOTPCode: %v", err)
				}
				_, err = f.svc.VerifyTOTP(ctx, token, code)
				return err
			}},
		{"logout", "DeleteSession", false, ErrLogoutFailed,
			func(t *testing.T, f *authCauseFixture) error {
				return f.svc.Logout(ctx, Principal{User: f.user, Session: &db.Session{TokenHash: "tok"}})
			}},
		{"confirm_totp_store", "UpdateUserTOTPSecret", true, ErrTOTPEnableFailed,
			func(t *testing.T, f *authCauseFixture) error {
				if _, err := f.svc.EnableTOTP(ctx, Principal{User: f.user}, causeLogPassword); err != nil {
					t.Fatalf("EnableTOTP: %v", err)
				}
				secret, ok := f.svc.pending.Lookup(ctx, f.user.ID)
				if !ok {
					t.Fatal("no pending enrolment")
				}
				code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
				if err != nil {
					t.Fatalf("GenerateTOTPCode: %v", err)
				}
				f.st.fail["UpdateUserTOTPSecret"] = cause
				_, err = f.svc.ConfirmTOTP(ctx, Principal{User: f.user}, causeLogPassword, code)
				return err
			}},
		{"disable_totp_policy", "GetSetting:require_2fa", false, ErrAuthPolicyUnavailable,
			func(t *testing.T, f *authCauseFixture) error {
				_, err := f.svc.DisableTOTP(ctx, Principal{User: f.user}, causeLogPassword)
				return err
			}},
		{"disable_totp_store", "UpdateUserTOTPSecret", false, ErrTOTPDisableFailed,
			func(t *testing.T, f *authCauseFixture) error {
				_, err := f.svc.DisableTOTP(ctx, Principal{User: f.user}, causeLogPassword)
				return err
			}},
		{"recovery_kit_readback", "GetRecoveryKit", false, ErrRecoveryKitFailed,
			func(t *testing.T, f *authCauseFixture) error {
				_, err := f.svc.EnrolRecoveryKit(ctx, Principal{User: f.user}, causeLogPassword, "")
				return err
			}},
		{"recovery_new_password_hash", "", false, ErrPasswordHash,
			func(t *testing.T, f *authCauseFixture) error {
				issue, err := f.svc.EnrolRecoveryKit(ctx, Principal{User: f.user}, causeLogPassword, "")
				if err != nil {
					t.Fatalf("EnrolRecoveryKit: %v", err)
				}
				// bcrypt refuses a password past 72 bytes.
				_, err = f.svc.RecoverWithKit(ctx, RecoverInput{
					Username: causeLogUser, KitSecret: issue.Secret,
					NewPassword: strings.Repeat("p", 100), Device: "dev", IP: causeLogIP,
				})
				return err
			}},
		{"recovery_fresh_user", "GetUserByID", true, ErrRecoveryFailed,
			func(t *testing.T, f *authCauseFixture) error {
				issue, err := f.svc.EnrolRecoveryKit(ctx, Principal{User: f.user}, causeLogPassword, "")
				if err != nil {
					t.Fatalf("EnrolRecoveryKit: %v", err)
				}
				// The closing re-read is the recovery's only GetUserByID.
				f.st.fail["GetUserByID"] = cause
				_, err = f.svc.RecoverWithKit(ctx, RecoverInput{
					Username: causeLogUser, KitSecret: issue.Secret,
					NewPassword: "Recovered-Pass2!", Device: "dev", IP: causeLogIP,
				})
				return err
			}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newAuthCauseFixture(t)
			if !tc.late && tc.fail != "" {
				f.st.fail[tc.fail] = cause
			}

			err := tc.run(t, f)
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}

			var errLines []string
			for line := range strings.SplitSeq(f.logs.String(), "\n") {
				if strings.Contains(line, "level=ERROR") {
					errLines = append(errLines, line)
				}
			}
			if len(errLines) != 1 {
				t.Fatalf("error log records = %d, want exactly 1:\n%s", len(errLines), strings.Join(errLines, "\n"))
			}
			wantText := cause.Error()
			if tc.name == "recovery_new_password_hash" {
				wantText = "72 bytes"
			}
			if !strings.Contains(errLines[0], wantText) {
				t.Fatalf("log record %q does not carry the cause %q", errLines[0], wantText)
			}
			for _, leak := range []string{causeLogUser, causeLogPassword, causeLogIP, "newbie"} {
				if strings.Contains(errLines[0], leak) {
					t.Fatalf("log record %q leaks request data %q", errLines[0], leak)
				}
			}
		})
	}
}
