package service

import (
	"context"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

const upgradePassword = "legacy password 1"

func newUpgradeFixture(t *testing.T) (*AuthService, *db.DB, int64, string) {
	t.Helper()
	database := newTestDB(t)
	legacy, err := bcrypt.GenerateFromPassword([]byte(upgradePassword), bcrypt.MinCost)
	mustDo(t, "bcrypt", err)
	uid := mustCreateUser(t, database, "legacy-user", string(legacy), 4)
	svc := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil)
	return svc, database, uid, string(legacy)
}

func upgradeLogin(svc *AuthService, password string) (*AuthResult, error) {
	return svc.Login(context.Background(), LoginInput{
		Username: "legacy-user", Password: password, Device: "test", IP: "203.0.113.20",
	})
}

// A sign-in on an older hash stores an argon2id one, and the account keeps signing in.
func TestLogin_UpgradesLegacyHash(t *testing.T) {
	svc, database, uid, legacy := newUpgradeFixture(t)

	if _, err := upgradeLogin(svc, upgradePassword); err != nil {
		t.Fatalf("first login: %v", err)
	}
	upgraded := mustGetUserByID(t, database, uid).PasswordHash
	if upgraded == legacy || !strings.HasPrefix(upgraded, "$argon2id$") {
		t.Fatalf("stored hash after login = %q, want an argon2id hash", upgraded)
	}

	if _, err := upgradeLogin(svc, upgradePassword); err != nil {
		t.Fatalf("login on the upgraded hash: %v", err)
	}
	if again := mustGetUserByID(t, database, uid).PasswordHash; again != upgraded {
		t.Fatal("a current hash was rewritten on the next login")
	}
}

// A wrong password leaves the older hash alone.
func TestLogin_WrongPasswordDoesNotUpgrade(t *testing.T) {
	svc, database, uid, legacy := newUpgradeFixture(t)
	if _, err := upgradeLogin(svc, "not the password"); err == nil {
		t.Fatal("login with a wrong password succeeded")
	}
	if got := mustGetUserByID(t, database, uid).PasswordHash; got != legacy {
		t.Fatalf("stored hash = %q after a failed login, want it unchanged", got)
	}
}

// changeFirstStore changes the password between the check and the upgrade write,
// as a password change in another session would.
type changeFirstStore struct {
	authCoreStore
	database *db.DB
	newHash  string
}

func (s changeFirstStore) UpgradeUserPasswordHash(ctx context.Context, userID int64, oldHash, newHash string) (bool, error) {
	if err := s.database.UpdateUserPassword(ctx, userID, s.newHash); err != nil {
		return false, err
	}
	return s.authCoreStore.UpgradeUserPasswordHash(ctx, userID, oldHash, newHash)
}

func TestLogin_UpgradeNeverOverwritesAChangedPassword(t *testing.T) {
	svc, database, uid, _ := newUpgradeFixture(t)
	changed, err := auth.HashPassword("the new password")
	mustDo(t, "HashPassword", err)
	svc.st = changeFirstStore{authCoreStore: database, database: database, newHash: changed}

	if _, err := upgradeLogin(svc, upgradePassword); err != nil {
		t.Fatalf("login that raced a password change: %v", err)
	}
	if got := mustGetUserByID(t, database, uid).PasswordHash; got != changed {
		t.Fatalf("stored hash = %q, want the changed password's hash kept", got)
	}
}
