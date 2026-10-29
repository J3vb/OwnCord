package app

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// limiterCleanupInterval is how often stale rate-limiter entries are reaped.
// Cleanup is per-key-window-aware (see auth/ratelimit.go's entry.window), so
// a single sweep retires a short-window key (login attempts, minutes) and a
// long one (service/appeal.go's 24h-per-user cap) alike.
const limiterCleanupInterval = 5 * time.Minute

// startLimiterCleanup reaps the shared limiter's stale entries on an App-owned
// context (it was a bare goroutine in api.NewRouter). The sweep also
// deletes expired persisted lockouts, so the close step cancels and joins the
// loop before the database closes: it registers after the "database" step.
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
