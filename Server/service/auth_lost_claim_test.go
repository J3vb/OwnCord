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
	uid := mustCreateUser(t, database, "racer", "$2a$12$x", 4)
	secret, err := auth.GenerateTOTPSecret()
	mustDo(t, "GenerateTOTPSecret", err)
	key := make([]byte, 32)
	enc, err := auth.EncryptTOTPSecret(key, secret)
	mustDo(t, "EncryptTOTPSecret", err)
	mustDo(t, "UpdateUserTOTPSecret", database.UpdateUserTOTPSecret(ctx, uid, &enc))

	var (
		svc   *AuthService
		token string
	)
	st := &lostClaimStore{Store: database, beforeUserRead: func() { svc.partial.Consume(ctx, token) }}
	svc = NewAuthService(st, auth.NewRateLimiter(), key, nil)
	token, err = svc.partial.Issue(ctx, uid, "device", "203.0.113.9")
	mustDo(t, "Issue", err)
	code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
	mustDo(t, "GenerateTOTPCode", err)

	if _, err := svc.VerifyTOTP(ctx, token, code); !errors.Is(err, ErrTOTPChallengeInvalid) {
		t.Fatalf("VerifyTOTP error = %v, want ErrTOTPChallengeInvalid (the claim lost)", err)
	}
	if !svc.usedCodes.MarkUsed(ctx, uid, code) {
		t.Fatal("the losing claim left its code marked as used")
	}
}
