package service

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/clientip"
)

// loginVouchWindow is how long a successful login from an address vouches for that
// (username, address) pair: the per-username lockout and failure budget then do not
// apply to it, since a flood from many addresses can lock any account, the owner's
// included, and an address that already authenticated is not that flood. The per-IP budget
// still bounds it and the voucher needs the correct password. Lives in the limiter, so a
// restart drops it while the persisted lockout survives.
const loginVouchWindow = 24 * time.Hour

func loginVouchKey(unameKey, ip string) string {
	return "login_user_ok:" + unameKey + ":" + clientip.RateKey(ip)
}

// loginVouched reports whether key holds a success inside loginVouchWindow. Check is
// "allowed" for an absent key, so negating a limit of 1 means "at least one success".
func (s *AuthService) loginVouched(key string) bool {
	return !s.limiter.Check(key, 1, loginVouchWindow)
}

func (s *AuthService) recordLoginVouch(ctx context.Context, key string) {
	s.limiter.Reset(ctx, key)
	s.limiter.Allow(key, 2, loginVouchWindow)
}
