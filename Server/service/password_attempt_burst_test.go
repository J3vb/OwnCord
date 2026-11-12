package service

import (
	"context"
	"errors"
	"sync"
	"testing"
)

// A burst of wrong passwords must be capped at what a sequential guesser gets: each attempt
// is counted before its compare, so concurrent requests cannot all pass the lockout check.
func TestPasswordConfirm_BurstIsCappedAtTheSequentialBudget(t *testing.T) {
	const attempts = 12
	sites := []struct {
		name  string
		wrong error
		call  func(f *admissionFixture, ctx context.Context) error
	}{
		{"DeleteAccount", ErrIncorrectPassword, func(f *admissionFixture, ctx context.Context) error {
			return f.svc.DeleteAccount(ctx, f.plain, "wrong password", "203.0.113.7")
		}},
		{"DisableTOTP", ErrPasswordConfirmationFailed, func(f *admissionFixture, ctx context.Context) error {
			_, err := f.svc.DisableTOTP(ctx, f.plain, "wrong password")
			return err
		}},
	}
	for _, site := range sites {
		t.Run(site.name, func(t *testing.T) {
			f := newAdmissionFixture(t, attempts)
			errs := make([]error, attempts)
			var wg sync.WaitGroup
			start := make(chan struct{})
			for i := range attempts {
				wg.Go(func() {
					<-start
					errs[i] = site.call(f, context.Background())
				})
			}
			close(start)
			wg.Wait()

			compared := 0
			for i, err := range errs {
				switch {
				case errors.Is(err, site.wrong):
					compared++
				case errors.Is(err, ErrTooManyAttempts):
				default:
					t.Errorf("attempt %d: error = %v, want %v or ErrTooManyAttempts", i, err, site.wrong)
				}
			}
			// Three failures plus the one that trips the lockout, as a sequential guesser gets.
			if want := PwConfirmFailureThreshold + 1; compared > want {
				t.Fatalf("%d compares ran in one burst, want at most %d", compared, want)
			}
		})
	}
}
