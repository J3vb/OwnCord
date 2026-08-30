package service

// Codex P2 on PR #1454 (B3-9, OC-0378): a verify whose challenge claim
// loses — a concurrent request consumed the challenge after this one marked
// its code — must release that code. Otherwise, when the winner is
// mid-recovery (Consume → issueSession failed → Restore), the restored token
// is stuck behind the loser's mark until the authenticator rolls over.
//
// The interleaving is forced deterministically: the store's GetUserByID runs
// between Lookup and the code check, so consuming the challenge from inside
// it leaves the token absent exactly when this request reaches Consume.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

type lostClaimStore struct {
	Store
	beforeUserRead func()
}

func (s *lostClaimStore) GetUserByID(ctx context.Context, id int64) (*db.User, error) {
	s.beforeUserRead()
	return s.Store.GetUserByID(ctx, id)
}

func TestVerifyTOTP_LostClaimReleasesTheCode(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	uid, err := database.CreateUser(ctx, "racer", "$2a$12$x", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		t.Fatalf("GenerateTOTPSecret: %v", err)
	}
	key := make([]byte, 32)
	enc, err := auth.EncryptTOTPSecret(key, secret)
	if err != nil {
		t.Fatalf("EncryptTOTPSecret: %v", err)
	}
	if err := database.UpdateUserTOTPSecret(ctx, uid, &enc); err != nil {
		t.Fatalf("UpdateUserTOTPSecret: %v", err)
	}

	var (
		svc   *AuthService
		token string
	)
	st := &lostClaimStore{Store: database, beforeUserRead: func() { svc.partial.Consume(token) }}
	svc = NewAuthService(st, auth.NewRateLimiter(), key, nil)
	token, err = svc.partial.Issue(uid, "device", "203.0.113.9")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}

	if _, err := svc.VerifyTOTP(ctx, token, code); !errors.Is(err, ErrTOTPChallengeInvalid) {
		t.Fatalf("VerifyTOTP error = %v, want ErrTOTPChallengeInvalid (the claim lost)", err)
	}
	if !svc.usedCodes.MarkUsed(uid, code) {
		t.Fatal("the losing claim left its code marked as used")
	}
}
