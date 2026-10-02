package service

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// A distributed attacker can trip the per-username lockout from many IPs and
// lock any account, the owner's included, for 15 minutes at a time. An IP that
// logged in successfully for that account recently is not the attacker, so it
// must still reach the password check instead of being locked out with them.
func TestLogin_LockedOutUsernameStillAdmitsARecentSuccessfulIP(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	hash, err := auth.HashPassword("securePass1")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if _, err := database.CreateUser(ctx, "owner", hash, 4); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	svc := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil)

	const knownIP = "198.51.100.7"
	if _, err := svc.Login(ctx, LoginInput{Username: "owner", Password: "securePass1", Device: "test", IP: knownIP}); err != nil {
		t.Fatalf("the owner's first login failed: %v", err)
	}

	// A flood of failures from many other addresses trips the per-username
	// lockout.
	for i := 1; i <= loginUserFailureThreshold+1; i++ {
		_, _ = svc.Login(ctx, LoginInput{Username: "owner", Password: "wrong", Device: "test", IP: fmt.Sprintf("203.0.113.%d", i)})
	}

	// An address that never logged in is still locked out (the defence stays).
	if _, err := svc.Login(ctx, LoginInput{Username: "owner", Password: "securePass1", Device: "test", IP: "203.0.113.250"}); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("an unknown address bypassed the username lockout: %v", err)
	}

	// The recent-successful address reaches the password check: a wrong
	// password is refused as invalid credentials, not as a lockout.
	if _, err := svc.Login(ctx, LoginInput{Username: "owner", Password: "wrong", Device: "test", IP: knownIP}); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("the known address did not reach the password check: %v", err)
	}

	// And the correct password actually logs in.
	if _, err := svc.Login(ctx, LoginInput{Username: "owner", Password: "securePass1", Device: "test", IP: knownIP}); err != nil {
		t.Fatalf("the owner was locked out of their own account from a known address: %v", err)
	}
}
