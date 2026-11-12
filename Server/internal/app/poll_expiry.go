package app

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
)

// pollExpiryJoinBudget bounds the close step's wait for the poll expirer loop.
const pollExpiryJoinBudget = 5 * time.Second

// startPollExpiry installs the hub as the expirer's notifier and runs one
// synchronous sweep, so polls that expired while the server was down are ended
// and announced before the listener opens; then it runs the loop on bgCtx,
// joined within pollExpiryJoinBudget.
func (a *App) startPollExpiry() error {
	svc := a.runtime.Services
	if svc == nil || svc.PollExpiry == nil {
		return nil
	}
	expirer := svc.PollExpiry
	if a.hub != nil {
		expirer.SetNotifier(a.hub)
	}
	if err := expirer.Sweep(a.bgCtx); err != nil {
		a.log.Warn("poll-expiry: boot sweep failed", "err", err)
	}
	stop := runPollExpirer(a.bgCtx, expirer)
	a.onCloseWithin("poll-expiry", pollExpiryJoinBudget, stop)
	return nil
}

func runPollExpirer(parent context.Context, expirer *service.PollExpirer) func(context.Context) error {
	return runExpirerLoop(parent, "poll expirer", expirer.Run)
}
