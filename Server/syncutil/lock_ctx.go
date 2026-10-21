package syncutil

import (
	"context"
	"fmt"
	"time"
)

// lockPollMax caps the wait between LockContext attempts.
const lockPollMax = 5 * time.Millisecond

// LockContext acquires mu unless ctx ends first. It returns nil with the lock
// held, or ctx's error wrapped, with the lock not held. It polls TryLock with a
// short growing backoff and starts no goroutine, so a caller whose context
// expires returns promptly and nothing is left behind to take the lock later.
func LockContext(ctx context.Context, mu *Mutex) error {
	if mu.TryLock() {
		return nil
	}
	wait := 50 * time.Microsecond
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("lock: %w", ctx.Err())
		case <-timer.C:
		}
		if mu.TryLock() {
			return nil
		}
		wait = min(wait*2, lockPollMax)
		timer.Reset(wait)
	}
}
