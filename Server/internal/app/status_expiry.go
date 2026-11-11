package app

import (
	"context"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
)

const statusExpiryJoinBudget = 5 * time.Second

// startStatusExpiry installs the hub as the expirer's notifier and runs one
// synchronous sweep, so statuses that expired while the server was down are
// gone before the listener opens; then it runs the loop on bgCtx, joined within
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
	// The loop context is a child of bgCtx, so event persistence cancelling
	// bgCtx also stops it; this step's own cancel stops it earlier.
	if err := expirer.Sweep(a.bgCtx); err != nil {
		a.log.Warn("status-expiry: boot sweep failed", "err", err)
	}
	stop := runStatusExpirer(a.bgCtx, expirer)
	a.onCloseWithin("status-expiry", statusExpiryJoinBudget, stop)
	return nil
}

func runStatusExpirer(parent context.Context, expirer *service.CustomStatusExpirer) func(context.Context) error {
	return runExpirerLoop(parent, "custom status expirer", expirer.Run)
}

// runExpirerLoop starts run on a child of parent and returns the close step
// that cancels it and waits; what names the loop in a timed-out close step's
// error. The status and poll expirers share it.
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
