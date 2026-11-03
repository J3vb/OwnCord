package service

import (
	"context"
	"errors"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// authCommon is what the auth parts share: the lockout limiter, the broadcaster
// and the password step. One value is built in NewAuthService and handed to
// every part by pointer, so the parts and the service always see the same limiter.
type authCommon struct {
	limiter     *auth.RateLimiter
	broadcaster AuthBroadcaster
}

// confirmPassword is the password step the TOTP routes share: a missing or wrong
// password counts against the pw_confirm budget and trips the lockout; a correct
// one resets it.
func (s *authCommon) confirmPassword(ctx context.Context, user *db.User, password, lockKey string) error {
	failKey := auth.Key("pw_confirm_fail", user.ID)
	if err := s.requirePasswordConfirmation(user, password); err != nil {
		if errors.Is(err, ErrAuthBusy) {
			// Refused before any compare ran: not an attempt.
			return err
		}
		if !s.limiter.Allow(failKey, PwConfirmFailureThreshold, PwConfirmFailureWindow) {
			s.limiter.Lockout(ctx, lockKey, PwConfirmLockoutDuration)
		}
		return err
	}
	s.limiter.Reset(ctx, failKey)
	return nil
}

// requirePasswordConfirmation checks the password inside one admission slot;
// ErrAuthBusy means no compare ran.
func (s *authCommon) requirePasswordConfirmation(user *db.User, password string) error {
	if password == "" {
		return ErrPasswordRequired
	}
	matched, admitted := s.limiter.Admission().CheckPassword(user.PasswordHash, password)
	if !admitted {
		return ErrAuthBusy
	}
	if !matched {
		return ErrPasswordConfirmationFailed
	}
	return nil
}
