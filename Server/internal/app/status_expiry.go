package app

import (
	"context"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
)

// statusExpiryJoinBudget bounds the close step's wait for the expirer loop.
const statusExpiryJoinBudget = 5 * time.Second

// startStatusExpiry installs the hub as the expirer's notifier, runs one
// synchronous sweep so statuses that expired while the server was down are gone
// before the http stage opens the listener, then runs the expirer loop on the
// background context. Its close step cancels and joins it within
// statusExpiryJoinBudget.
func (a *App) startStatusExpiry() error {
	svc := a.runtime.Services
	if svc == nil || svc.StatusExpiry == nil {
		return nil
	}
	expirer := svc.StatusExpiry
	if a.hub != nil {
		expirer.SetNotifier(a.hub)
	}
	// The loop context is a child of bgCtx, so the event-persistence step
	// cancelling bgCtx also stops it; this step's own cancel stops it earlier.
	if err := expirer.Sweep(a.bgCtx); err != nil {
		// Not fatal: the loop's first pass retries, and a status that lingers
		// a little longer is the only cost.
		a.log.Warn("status-expiry: boot sweep failed", "err", err)
	}
	stop := runStatusExpirer(a.bgCtx, expirer)
	a.onCloseWithin("status-expiry", statusExpiryJoinBudget, stop)
	return nil
}

// runStatusExpirer starts expirer.Run on a child of parent and returns the
// close step that cancels it and waits for it to exit.
func runStatusExpirer(parent context.Context, expirer *service.CustomStatusExpirer) func(context.Context) error {
	return runExpirerLoop(parent, "custom status expirer", expirer.Run)
}

// runExpirerLoop starts run on a child of parent and returns the close step
// that cancels it and waits for it to exit. what names the loop in the error a
// timed-out close step reports. The status and poll expirers share it.
func runExpirerLoop(parent context.Context, what string, run func(context.Context)) func(context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		run(ctx)
	}()
	return func(closeCtx context.Context) error {
		cancel()
		select {
		case <-done:
			return nil
		case <-closeCtx.Done():
			return fmt.Errorf("%s did not exit: %w", what, closeCtx.Err())
		}
	}
}
