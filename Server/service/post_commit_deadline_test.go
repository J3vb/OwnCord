package service

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// cancelAfterCommitStore ends the request context right after the write commits, as a request
// deadline passing at that moment would.
type cancelAfterCommitStore struct {
	*db.DB
	cancel context.CancelFunc
	// readCancels makes the first user re-read cancel the request context before it runs.
	readCancels bool
}

func (s *cancelAfterCommitStore) RedeemRecoveryKit(ctx context.Context, userID int64, verifier, newHash, action, detail string) (int64, error) {
	n, err := s.DB.RedeemRecoveryKit(ctx, userID, verifier, newHash, action, detail)
	s.cancel()
	return n, err
}

func (s *cancelAfterCommitStore) GetUserByID(ctx context.Context, id int64) (*db.User, error) {
	if s.readCancels {
		s.readCancels = false
		s.cancel()
	}
	return s.DB.GetUserByID(ctx, id)
}

func TestRecovery_CommittedRecoveryReportsSuccessAfterTheDeadline(t *testing.T) {
	database := newTestDB(t)
	hash, err := auth.HashPassword(causeLogPassword)
	mustDo(t, "HashPassword", err)
	uid := mustCreateUser(t, database, causeLogUser, hash, 4)
	user := mustGetUserByID(t, database, uid)
	reqCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	svc := NewAuthService(&cancelAfterCommitStore{DB: database, cancel: cancel}, auth.NewRateLimiter(), make([]byte, 32), nil)
	issue, err := svc.EnrolRecoveryKit(context.Background(), sessionPrincipal(user), causeLogPassword, "")
	mustDo(t, "EnrolRecoveryKit", err)

	res, err := svc.RecoverWithKit(reqCtx, RecoverInput{
		Username: causeLogUser, KitSecret: issue.Secret, NewPassword: "Recovered-Pass2!", Device: "dev", IP: causeLogIP,
	})
	if err != nil || res == nil || res.Token == "" || res.User == nil {
		t.Fatalf("recovery whose deadline passed after the commit = %+v, %v; want a signed-in result", res, err)
	}
}

func TestRegister_CommittedSignUpReportsSuccessAfterTheDeadline(t *testing.T) {
	database := newTestDB(t)
	mustDo(t, "SetSetting", database.SetSetting(context.Background(), registrationModeKey, string(RegistrationOpen)))
	reqCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	st := &cancelAfterCommitStore{DB: database, cancel: cancel}
	// Armed once the account exists, so only the read-back after the commit meets the dead context.
	st.readCancels = true
	svc := NewAuthService(st, auth.NewRateLimiter(), make([]byte, 32), nil)

	res, err := svc.Register(reqCtx, RegisterInput{Username: "latecomer", Password: "securePass1", Device: "test", IP: "203.0.113.7"})
	if err != nil || res == nil || res.Token == "" || res.User == nil {
		t.Fatalf("sign-up whose deadline passed after the commit = %+v, %v; want a signed-in result", res, err)
	}
}

// cancelBeforeSessionStore ends the request context just before the session insert, as a
// request deadline passing after the second factor was spent would.
type cancelBeforeSessionStore struct {
	*db.DB
	cancel context.CancelFunc
}

func (s *cancelBeforeSessionStore) CreateSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error) {
	s.cancel()
	return s.DB.CreateSession(ctx, userID, tokenHash, device, ip)
}

func TestVerifyTOTP_SpentCodeStillStartsTheSessionAfterTheDeadline(t *testing.T) {
	database := newTestDB(t)
	uid := mustCreateUser(t, database, "lateverify", "$2a$12$x", 4)
	secret, err := auth.GenerateTOTPSecret()
	mustDo(t, "GenerateTOTPSecret", err)
	key := make([]byte, 32)
	enc, err := auth.EncryptTOTPSecret(key, secret)
	mustDo(t, "EncryptTOTPSecret", err)
	mustDo(t, "UpdateUserTOTPSecret", database.UpdateUserTOTPSecret(context.Background(), uid, &enc))

	reqCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	svc := NewAuthService(&cancelBeforeSessionStore{DB: database, cancel: cancel}, auth.NewRateLimiter(), key, nil)
	token, err := svc.partial.Issue(reqCtx, uid, "device", "203.0.113.9")
	mustDo(t, "Issue", err)
	code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
	mustDo(t, "GenerateTOTPCode", err)

	res, err := svc.VerifyTOTP(reqCtx, token, code)
	if err != nil || res == nil || res.Token == "" {
		t.Fatalf("VerifyTOTP whose deadline passed after the code was spent = %+v, %v; want a session", res, err)
	}
}
