package service

import (
	"context"
	"time"
)

// runDueLoop is the loop the expirers and the thread archiver share. It sleeps
// for what nextSleep returns, or until wake, then runs sweep; after a failed
// read (failed true) it skips the sweep, and after a failed sweep it reports
// the error to sweepFailed (which logs it under the owner's own message) and
// waits retryAfter. It returns when ctx is done.
func runDueLoop(
	ctx context.Context,
	wake <-chan struct{},
	nextSleep func(context.Context) (time.Duration, bool),
	sweep func(context.Context) error,
	retryAfter time.Duration,
	sweepFailed func(error),
) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		sleep, failed := nextSleep(ctx)
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(sleep)
		select {
		case <-ctx.Done():
			return
		case <-wake:
			continue
		case <-timer.C:
		}
		if failed {
			continue
		}
		if err := sweep(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			sweepFailed(err)
			sleepOrDone(ctx, retryAfter)
		}
	}
}

func sleepOrDone(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// dueSleep is how long to sleep until at plus slack, clamped to [0, maxSleep].
func dueSleep(at, now time.Time, slack, maxSleep time.Duration) time.Duration {
	return min(max(at.Add(slack).Sub(now), 0), maxSleep)
}
