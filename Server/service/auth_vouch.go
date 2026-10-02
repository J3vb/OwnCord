package service

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/clientip"
)

// loginVouchWindow is how long a successful login from an address vouches for
// that (username, address) pair. Within it the per-username lockout and failure
// budget do not apply to that address: a flood from many addresses can lock any
// account — the owner's included — out for 15 minutes at a time, and an address
// that already authenticated the account is not that flood. The per-IP budget
// still bounds it, and the voucher needs the correct password, so only an
// address that already proved it holds one. It lives in the limiter, so a
// restart drops it while the persisted lockout survives.
const loginVouchWindow = 24 * time.Hour

// loginVouchKey is the limiter key for one (username, address) voucher.
// unameKey is the canonical username (db.LowerASCII).
func loginVouchKey(unameKey, ip string) string {
	return "login_user_ok:" + unameKey + ":" + clientip.RateKey(ip)
}

// loginVouched reports whether key holds a success inside loginVouchWindow.
// Check is "allowed" — true for an absent key and for one whose only
// timestamp fell out of the window — so negating a limit of 1 means exactly
// "at least one success was recorded".
func (s *AuthService) loginVouched(key string) bool {
	return !s.limiter.Check(key, 1, loginVouchWindow)
}

// recordLoginVouch stamps a success on key. Reset first so each success
// refreshes the window rather than accumulating.
func (s *AuthService) recordLoginVouch(ctx context.Context, key string) {
	s.limiter.Reset(ctx, key)
	s.limiter.Allow(key, 2, loginVouchWindow)
}
