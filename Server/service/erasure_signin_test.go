package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

func sessionCount(t *testing.T, database *db.DB, uid int64) int {
	t.Helper()
	var n int
	mustDo(t, "QueryRowContext", database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, uid).Scan(&n))
	return n
}

// Sign-in is refused while an account deletion is being completed: after the
// lock stage a correct password issues no session.
func TestAuthService_LoginRefusedWhileDeletionIsBeingCompleted(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	hash, err := auth.HashPassword("correct horse battery")
	mustDo(t, "HashPassword", err)
	mustCreateUser(t, database, "keeper-owner", hash, 1)
	uid := mustCreateUser(t, database, "leaving-member", hash, 4)
	svc := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil)
	if _, err := database.EraseAccountLock(ctx, uid, true); err != nil {
		t.Fatalf("EraseAccountLock: %v", err)
	}
	_, err = svc.Login(ctx, LoginInput{Username: "leaving-member", Password: "correct horse battery", Device: "d", IP: "203.0.113.9"})
	if !errors.Is(err, ErrBanned) {
		t.Fatalf("Login = %v, want ErrBanned", err)
	}
	if n := sessionCount(t, database, uid); n != 0 {
		t.Errorf("sessions after the refused sign-in = %d, want 0", n)
	}
}

// The second-factor step is refused the same way.
func TestAuthService_VerifyTOTPRefusedWhileDeletionIsBeingCompleted(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	uid := mustCreateUser(t, database, "leaving-totp", "$2a$12$x", 4)
	mustCreateUser(t, database, "keeper-owner", "$2a$12$x", 1)
	secret, err := auth.GenerateTOTPSecret()
	mustDo(t, "GenerateTOTPSecret", err)
	key := make([]byte, 32)
	enc, err := auth.EncryptTOTPSecret(key, secret)
	mustDo(t, "EncryptTOTPSecret", err)
	mustDo(t, "UpdateUserTOTPSecret", database.UpdateUserTOTPSecret(ctx, uid, &enc))
	svc := NewAuthService(database, auth.NewRateLimiter(), key, nil)
	if _, err := database.EraseAccountLock(ctx, uid, true); err != nil {
		t.Fatalf("EraseAccountLock: %v", err)
	}
	// A challenge issued after the lock (a password step that was in flight).
	partial, err := svc.partial.Issue(ctx, uid, "device", "203.0.113.9")
	mustDo(t, "Issue", err)
	code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
	mustDo(t, "GenerateTOTPCode", err)
	if _, err := svc.VerifyTOTP(ctx, partial, code); !errors.Is(err, ErrBanned) {
		t.Fatalf("VerifyTOTP = %v, want ErrBanned", err)
	}
	if n := sessionCount(t, database, uid); n != 0 {
		t.Errorf("sessions after the refused second factor = %d, want 0", n)
	}
}
