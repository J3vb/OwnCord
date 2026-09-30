package service

import (
	"context"
	"time"
)

// authBusyError is ErrAuthBusy from a site that queued for its admission
// slot (P5-S02): the same refusal and message, plus the budget's estimate of
// when a retry is likely to be admitted, which the transport sends as
// Retry-After.
type authBusyError struct{ retryAfter time.Duration }

func (e *authBusyError) Error() string { return ErrAuthBusy.Error() }
func (e *authBusyError) Is(target error) bool {
	return target == ErrAuthBusy || target == ErrRateLimited
}
func (e *authBusyError) RetryAfter() time.Duration { return e.retryAfter }

// acquireAdmission queues for an admission slot for up to s.admissionWait;
// a refusal is ErrAuthBusy carrying the budget's retry hint.
func (s *AuthService) acquireAdmission(ctx context.Context) (release func(), err error) {
	release, retryAfter, ok := s.limiter.Admission().Acquire(ctx, s.admissionWait)
	if !ok {
		return release, &authBusyError{retryAfter}
	}
	return release, nil
}
