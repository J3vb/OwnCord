package service

import (
	"context"
	"errors"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// postCommitTimeout bounds the steps that finish an already committed sign-in or sign-up.
const postCommitTimeout = 5 * time.Second

// postCommitContext outlives the request's deadline: once the write committed, a request that
// timed out meanwhile must still report success, not a retry that finds the work done.
func postCommitContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), postCommitTimeout)
}

// authCommon is what the auth parts share: the limiter, broadcaster and password step.
// One value is handed to every part by pointer so all see the same limiter.
type authCommon struct {
	limiter     *auth.RateLimiter
	broadcaster AuthBroadcaster
}

// ReservePasswordAttempt counts one password attempt on failKey before the compare runs, so
// concurrent requests cannot all pass a lockout check first. The budget is threshold+1: the
// last failure trips the lockout via SettleFailedAttempt and a correct last password still
// succeeds. refund takes the attempt back when no compare ran; ok is false when spent.
func ReservePasswordAttempt(l *auth.RateLimiter, failKey string, threshold int, window time.Duration) (refund func(), ok bool) {
	return l.Reserve(failKey, threshold+1, window)
}

// SettleFailedAttempt locks lockKey out once a failed compare used up the budget taken by
// ReservePasswordAttempt. Check is read-only: the attempt is already counted.
func SettleFailedAttempt(ctx context.Context, l *auth.RateLimiter, failKey, lockKey string, threshold int, window, lockout time.Duration) {
	if !l.Check(failKey, threshold+1, window) {
		l.Lockout(ctx, lockKey, lockout)
	}
}

// confirmPassword is the password step the TOTP routes share: every attempt is counted before
// the compare and trips the lockout once the budget is used; a correct password resets it.
func (s *authCommon) confirmPassword(ctx context.Context, user *db.User, password, lockKey string) error {
	failKey := auth.Key("pw_confirm_fail", user.ID)
	refund, ok := ReservePasswordAttempt(s.limiter, failKey, PwConfirmFailureThreshold, PwConfirmFailureWindow)
	if !ok {
		return ErrTooManyAttempts
	}
	if err := s.requirePasswordConfirmation(user, password); err != nil {
		if errors.Is(err, ErrAuthBusy) {
			// Refused before any compare ran: not an attempt.
			refund()
			return err
		}
		SettleFailedAttempt(ctx, s.limiter, failKey, lockKey, PwConfirmFailureThreshold, PwConfirmFailureWindow, PwConfirmLockoutDuration)
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
