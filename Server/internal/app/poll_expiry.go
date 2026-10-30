package app

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
)

// pollExpiryJoinBudget bounds the close step's wait for the poll expirer loop.
const pollExpiryJoinBudget = 5 * time.Second

// startPollExpiry installs the hub as the poll expirer's notifier, runs one
// synchronous sweep so polls that expired while the server was down are ended
// and announced (sequenced into replay) before the http stage opens the
// listener, then runs the expirer loop on the background context. Its close
// step cancels and joins it within pollExpiryJoinBudget.
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
		// Not fatal: the loop's first pass retries, and readers stay correct
		// because a vote is refused after expiry by the database clock and
		// history reads an expired poll as ended.
		a.log.Warn("poll-expiry: boot sweep failed", "err", err)
	}
	stop := runPollExpirer(a.bgCtx, expirer)
	a.onCloseWithin("poll-expiry", pollExpiryJoinBudget, stop)
	return nil
}

// runPollExpirer starts expirer.Run on a child of parent and returns the close
// step that cancels it and waits for it to exit.
func runPollExpirer(parent context.Context, expirer *service.PollExpirer) func(context.Context) error {
	return runExpirerLoop(parent, "poll expirer", expirer.Run)
}
