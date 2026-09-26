package service

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// OC-0324 (B4-12 batch (c)): the per-username lockout key must fold the way
// the account lookup does — SQLite COLLATE NOCASE, ASCII A–Z only — so two
// accounts that differ only in non-ASCII case never share a lockout bucket,
// while ASCII case variants of one account still do.
func TestLogin_LockoutKeyFoldsLikeTheAccountLookup(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	hash, err := auth.HashPassword("securePass1")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	// "ärger" and "Ärger" are two rows: NOCASE does not fold Ä/ä.
	for _, name := range []string{"ärger", "Ärger", "admin"} {
		if _, err := database.CreateUser(ctx, name, hash, 4); err != nil {
			t.Fatalf("CreateUser(%s): %v", name, err)
		}
	}
	svc := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil)
	// Distinct addresses per attempt keep the per-IP gate out of the way.
	login := func(username, password string, ip int) error {
		_, err := svc.Login(ctx, LoginInput{Username: username, Password: password, Device: "test", IP: fmt.Sprintf("203.0.113.%d", ip)})
		return err
	}

	for i := 1; i <= loginUserFailureThreshold+1; i++ {
		if err := login("ärger", "wrong", i); err == nil {
			t.Fatalf("attempt %d with a wrong password succeeded", i)
		}
	}
	if err := login("ärger", "securePass1", 50); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("the hammered account is not locked: %v", err)
	}
	if err := login("Ärger", "securePass1", 51); err != nil {
		t.Fatalf("the sibling account shares the lockout bucket (OC-0324): %v", err)
	}

	// ASCII case variants of one account keep sharing a bucket.
	for i := 1; i <= loginUserFailureThreshold+1; i++ {
		_ = login("ADMIN", "wrong", 100+i)
	}
	if err := login("admin", "securePass1", 150); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("ASCII case variants no longer share the lockout: %v", err)
	}
}
