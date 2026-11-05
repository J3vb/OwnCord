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

// newSessionToken generates a bearer token and hands its hash to persist (the
// session row insert). The token is returned only once persist succeeded.
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

// sessionIssueError maps a failed session issue; sign-in is refused while an
// account deletion is being completed.
func sessionIssueError(err error) error {
	if errors.Is(err, db.ErrAccountErasing) {
		return ErrBanned
	}
	return ErrSessionIssue
}

// sessionCreator writes a new session row.
type sessionCreator interface {
	CreateSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error)
}

func issueSession(ctx context.Context, st sessionCreator, userID int64, device, ip string) (string, error) {
	return newSessionToken(func(tokenHash string) error {
		_, err := st.CreateSession(ctx, userID, tokenHash, device, ip)
		return err
	})
}
