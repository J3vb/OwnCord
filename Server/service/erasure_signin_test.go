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
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, uid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Sign-in is refused while an account deletion is being completed: after the
// lock stage a correct password issues no session.
func TestAuthService_LoginRefusedWhileDeletionIsBeingCompleted(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	hash, err := auth.HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateUser(ctx, "keeper-owner", hash, 1); err != nil {
		t.Fatal(err)
	}
	uid, err := database.CreateUser(ctx, "leaving-member", hash, 4)
	if err != nil {
		t.Fatal(err)
	}
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
	uid, err := database.CreateUser(ctx, "leaving-totp", "$2a$12$x", 4)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateUser(ctx, "keeper-owner", "$2a$12$x", 1); err != nil {
		t.Fatal(err)
	}
	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		t.Fatal(err)
	}
	key := make([]byte, 32)
	enc, err := auth.EncryptTOTPSecret(key, secret)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.UpdateUserTOTPSecret(ctx, uid, &enc); err != nil {
		t.Fatal(err)
	}
	svc := NewAuthService(database, auth.NewRateLimiter(), key, nil)
	if _, err := database.EraseAccountLock(ctx, uid, true); err != nil {
		t.Fatalf("EraseAccountLock: %v", err)
	}
	// A challenge issued after the lock (a password step that was in flight).
	partial, err := svc.partial.Issue(ctx, uid, "device", "203.0.113.9")
	if err != nil {
		t.Fatal(err)
	}
	code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.VerifyTOTP(ctx, partial, code); !errors.Is(err, ErrBanned) {
		t.Fatalf("VerifyTOTP = %v, want ErrBanned", err)
	}
	if n := sessionCount(t, database, uid); n != 0 {
		t.Errorf("sessions after the refused second factor = %d, want 0", n)
	}
}
