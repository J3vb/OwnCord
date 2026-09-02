package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// S-13 (B4-3) at the service tier: a login challenge issued by one process
// completes in another, and a TOTP code spent in one process is refused in
// another — the database, not the process, remembers. A "process" here is a
// fresh AuthService over the same database.

func secondFactorDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func TestSecondFactor_ChallengeAndReplayWindowSurviveRestart(t *testing.T) {
	ctx := context.Background()
	database := secondFactorDB(t)
	key := make([]byte, 32)

	hash, err := auth.HashPassword("correctPass1")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	uid, err := database.CreateUser(ctx, "restarter", hash, 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		t.Fatalf("GenerateTOTPSecret: %v", err)
	}
	enc, err := auth.EncryptTOTPSecret(key, secret)
	if err != nil {
		t.Fatalf("EncryptTOTPSecret: %v", err)
	}
	if err := database.UpdateUserTOTPSecret(ctx, uid, &enc); err != nil {
		t.Fatalf("UpdateUserTOTPSecret: %v", err)
	}
	login := LoginInput{Username: "restarter", Password: "correctPass1", Device: "d", IP: "203.0.113.5"}

	first := NewAuthService(database, auth.NewRateLimiter(), key, nil)
	res, err := first.Login(ctx, login)
	if err != nil || !res.Requires2FA {
		t.Fatalf("Login = %+v, %v; want a 2FA challenge", res, err)
	}

	// The process restarts: a new service, an empty cache, the same database.
	second := NewAuthService(database, auth.NewRateLimiter(), key, nil)
	code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}
	done, err := second.VerifyTOTP(ctx, res.PartialToken, code)
	if err != nil || done.Token == "" {
		t.Fatalf("VerifyTOTP after restart = %+v, %v; want a session", done, err)
	}

	// The spent code is refused everywhere, including by the process that
	// never saw it.
	again, err := first.Login(ctx, login)
	if err != nil {
		t.Fatalf("second Login: %v", err)
	}
	if _, err := first.VerifyTOTP(ctx, again.PartialToken, code); !errors.Is(err, ErrTOTPCodeInvalid) {
		t.Fatalf("replay across processes: err = %v, want ErrTOTPCodeInvalid", err)
	}

	// And the challenge the new process consumed is gone for the old one too.
	if _, err := first.VerifyTOTP(ctx, res.PartialToken, code); !errors.Is(err, ErrTOTPChallengeInvalid) {
		t.Fatalf("consumed challenge in the old process: err = %v, want ErrTOTPChallengeInvalid", err)
	}
}

func TestSecondFactor_PendingEnrolmentSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	database := secondFactorDB(t)
	key := make([]byte, 32)

	hash, err := auth.HashPassword("correctPass1")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	uid, err := database.CreateUser(ctx, "enroller", hash, 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	p := Principal{User: user}

	first := NewAuthService(database, auth.NewRateLimiter(), key, nil)
	enr, err := first.EnableTOTP(ctx, p, "correctPass1")
	if err != nil {
		t.Fatalf("EnableTOTP: %v", err)
	}
	if len(enr.RecoveryCodes) != 10 {
		t.Fatalf("EnableTOTP issued %d recovery codes, want 10", len(enr.RecoveryCodes))
	}

	// Restart between enable and confirm: the staged secret must still be
	// there, sealed in the database, for the confirm step.
	second := NewAuthService(database, auth.NewRateLimiter(), key, nil)
	secret, ok := second.pending.Lookup(ctx, uid)
	if !ok {
		t.Fatal("the staged enrolment did not survive the restart")
	}
	code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}
	if _, err := second.ConfirmTOTP(ctx, p, "correctPass1", code); err != nil {
		t.Fatalf("ConfirmTOTP after restart: %v", err)
	}

	// The recovery codes issued by the first process work in a third one,
	// once each.
	third := NewAuthService(database, auth.NewRateLimiter(), key, nil)
	res, err := third.Login(ctx, LoginInput{Username: "enroller", Password: "correctPass1"})
	if err != nil || !res.Requires2FA {
		t.Fatalf("Login = %+v, %v", res, err)
	}
	done, err := third.VerifyTOTP(ctx, res.PartialToken, enr.RecoveryCodes[3])
	if err != nil || done.RecoveryCodesRemaining == nil || *done.RecoveryCodesRemaining != 9 {
		t.Fatalf("VerifyTOTP with a recovery code = %+v, %v; want a session and 9 remaining", done, err)
	}
	res, err = third.Login(ctx, LoginInput{Username: "enroller", Password: "correctPass1"})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if _, err := third.VerifyTOTP(ctx, res.PartialToken, enr.RecoveryCodes[3]); !errors.Is(err, ErrTOTPCodeInvalid) {
		t.Fatalf("a spent recovery code: err = %v, want ErrTOTPCodeInvalid", err)
	}
}
