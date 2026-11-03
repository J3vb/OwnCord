package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// sessionPrincipal is a principal that holds a login session, the shape the
// account-security methods require.
func sessionPrincipal(u *db.User) Principal {
	return Principal{User: u, Session: &db.Session{UserID: u.ID}}
}

// TestAccountSecurityMethods_RefuseAPITokenPrincipal pins the service-level
// check: every account-security method refuses a principal without a login
// session before it reads or writes anything, so a route that forgets the
// transport middleware still fails closed.
func TestAccountSecurityMethods_RefuseAPITokenPrincipal(t *testing.T) {
	ctx := context.Background()
	// A nil store and limiter prove the refusal comes first: touching either
	// would panic.
	svc := &AuthService{}
	p := Principal{User: &db.User{ID: 7, Username: "bot-owner"}}

	calls := map[string]func() error{
		"EnableTOTP": func() error {
			_, err := svc.EnableTOTP(ctx, p, "pw")
			return err
		},
		"ConfirmTOTP": func() error {
			_, err := svc.ConfirmTOTP(ctx, p, "pw", "123456")
			return err
		},
		"DisableTOTP": func() error {
			_, err := svc.DisableTOTP(ctx, p, "pw")
			return err
		},
		"RegenerateRecoveryCodes": func() error {
			_, err := svc.RegenerateRecoveryCodes(ctx, p, "pw")
			return err
		},
		"EnrolRecoveryKit": func() error {
			_, err := svc.EnrolRecoveryKit(ctx, p, "pw", "")
			return err
		},
		"DeleteAccount": func() error {
			return svc.DeleteAccount(ctx, p, "pw", "203.0.113.9")
		},
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			err := call()
			if !errors.Is(err, ErrLoginSessionRequired) {
				t.Fatalf("err = %v, want ErrLoginSessionRequired", err)
			}
			if !errors.Is(err, ErrForbidden) {
				t.Fatalf("err = %v, want the forbidden category", err)
			}
		})
	}
}
