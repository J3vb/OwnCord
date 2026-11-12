package service

import (
	"context"
	"errors"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// authCommon is what the auth parts share: the limiter, broadcaster and password step.
// One value is handed to every part by pointer so all see the same limiter.
type authCommon struct {
	limiter     *auth.RateLimiter
	broadcaster AuthBroadcaster
}

// confirmPassword is the password step the TOTP routes share: a missing or wrong password
// counts against the pw_confirm budget and trips the lockout; a correct one resets it.
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

// newSessionToken hands a new token's hash to persist; the token is returned only once persist succeeded.
func newSessionToken(persist func(tokenHash string) error) (string, error) {
	token, err := auth.GenerateToken()
	if err != nil {
		return "", err
	}
	if err := persist(auth.HashToken(token)); err != nil {
		return "", err
	}
	return token, nil
}

func sessionIssueError(err error) error {
	if errors.Is(err, db.ErrAccountErasing) {
		return ErrBanned
	}
	return ErrSessionIssue
}

type sessionCreator interface {
	CreateSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error)
}

func issueSession(ctx context.Context, st sessionCreator, userID int64, device, ip string) (string, error) {
	return newSessionToken(func(tokenHash string) error {
		_, err := st.CreateSession(ctx, userID, tokenHash, device, ip)
		return err
	})
}
