package service

import (
	"context"
	"time"
)

// authBusyError is ErrAuthBusy from a site that queued for its admission slot, plus the
// budget's estimate of when a retry will be admitted (sent as Retry-After).
type authBusyError struct{ retryAfter time.Duration }

func (e *authBusyError) Error() string { return ErrAuthBusy.Error() }
func (e *authBusyError) Is(target error) bool {
	return target == ErrAuthBusy || target == ErrRateLimited
}
func (e *authBusyError) RetryAfter() time.Duration { return e.retryAfter }

func (s *AuthService) acquireAdmission(ctx context.Context) (release func(), err error) {
	release, retryAfter, ok := s.limiter.Admission().Acquire(ctx, s.admissionWait)
	if !ok {
		return release, &authBusyError{retryAfter}
	}
	return release, nil
}
