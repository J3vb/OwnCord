package app

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// limiterCleanupInterval is how often stale rate-limiter entries are reaped;
// cleanup is per-key-window-aware, so one sweep retires short and long (24h)
// windows alike.
const limiterCleanupInterval = 5 * time.Minute

// startLimiterCleanup reaps stale limiter entries on an App-owned context.
func (a *App) startLimiterCleanup(rl *auth.RateLimiter) {
	ctx, cancel := context.WithCancel(context.WithoutCancel(a.bgCtx))
	done := make(chan struct{})
	go func() {
		defer close(done)
		rl.RunCleanup(ctx, limiterCleanupInterval)
	}()
	a.onClose("limiter-cleanup", func(closeCtx context.Context) error {
		cancel()
		select {
		case <-done:
		case <-closeCtx.Done():
			a.log.Warn("limiter cleanup did not stop before the close budget ran out")
		}
		return nil
	})
}
