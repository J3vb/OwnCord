package service

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// newAddressBudgetEnv seeds "mine" with a known password; banned bans it.
func newAddressBudgetEnv(t *testing.T, banned bool) *AuthService {
	t.Helper()
	database := newTestDB(t)
	hash, err := auth.HashPassword("securePass1")
	mustDo(t, "HashPassword", err)
	uid := mustCreateUser(t, database, "mine", hash, 4)
	if banned {
		mustDo(t, "BanUser", database.BanUser(context.Background(), uid, "test", nil))
	}
	return NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil)
}

func failGuesses(t *testing.T, svc *AuthService, ip string, from, n int) {
	t.Helper()
	for i := from; i < from+n; i++ {
		_, err := svc.Login(context.Background(), LoginInput{Username: fmt.Sprintf("guess%d", i), Password: "wrongPass1", Device: "test", IP: ip})
		if !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("guess %d: err = %v, want invalid credentials", i, err)
		}
	}
}

// A correct password for one account leaves the address's failures for other
// usernames counted, whether that account may sign in or is banned: the tenth
// failure inside the window still locks the address.
func TestLogin_CorrectPasswordKeepsOtherUsernamesAddressFailures(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name    string
		banned  bool
		wantErr error
	}{
		{"active account", false, nil},
		{"banned account", true, ErrBanned},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			svc := newAddressBudgetEnv(t, tc.banned)
			const ip = "198.51.100.40"
			failGuesses(t, svc, ip, 1, 4)
			if _, err := svc.Login(context.Background(), LoginInput{Username: "mine", Password: "securePass1", Device: "test", IP: ip}); !errors.Is(err, tc.wantErr) {
				t.Fatalf("own sign-in: err = %v, want %v", err, tc.wantErr)
			}
			failGuesses(t, svc, ip, 5, loginFailureThreshold-4)
			// The address now holds loginFailureThreshold failures; one more locks it.
			_, _ = svc.Login(context.Background(), LoginInput{Username: "guess99", Password: "wrongPass1", Device: "test", IP: ip})
			if _, err := svc.Login(context.Background(), LoginInput{Username: "guess100", Password: "wrongPass1", Device: "test", IP: ip}); !errors.Is(err, ErrRateLimited) {
				t.Fatalf("after %d failures the address is not locked: %v", loginFailureThreshold+1, err)
			}
		})
	}
}

// A person who mistypes and then signs in keeps signing in: successes never
// spend the address budget, so repeated sign-ins after a few typos all pass.
func TestLogin_SuccessesDoNotSpendTheAddressBudget(t *testing.T) {
	t.Parallel()
	svc := newAddressBudgetEnv(t, false)
	const ip = "198.51.100.41"
	for i := range loginFailureThreshold - 1 {
		if _, err := svc.Login(context.Background(), LoginInput{Username: "mine", Password: "typo-" + fmt.Sprint(i), Device: "test", IP: ip}); !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("typo %d: err = %v, want invalid credentials", i, err)
		}
	}
	for i := range 4 {
		if _, err := svc.Login(context.Background(), LoginInput{Username: "mine", Password: "securePass1", Device: "test", IP: ip}); err != nil {
			t.Fatalf("sign-in %d after typos: %v", i+1, err)
		}
	}
}

// The vouch key keeps the address and the username apart even when the
// username holds ':' and the address is IPv6.
func TestLoginVouchKey_PartsCannotRunTogether(t *testing.T) {
	t.Parallel()
	if a, b := loginVouchKey("bob:2001", "db8:1:2::1"), loginVouchKey("bob", "2001:db8:1:2::1"); a == b {
		t.Fatalf("different pairs share the key %q", a)
	}
	if a, b := loginVouchKey("bob", "192.0.2.1"), loginVouchKey("bob", "192.0.2.1"); a != b {
		t.Fatalf("same pair gave %q and %q", a, b)
	}
}
