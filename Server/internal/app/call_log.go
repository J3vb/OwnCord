package app

import "context"

// startCallLog starts the DM call log worker (WP 3B-9). It runs after event
// persistence so the frames its start-up recovery emits are persisted for
// replay, and before the http stage opens the listener, so nobody is connected
// while leftover calls from the previous run are ended.
//
// The loop context is deliberately not bgCtx: the event-persistence close step
// cancels bgCtx, and the stop pass must still be able to write. This step's
// close runs before that one (the reverse walk), under the close step's own
// bounded context; the stop func joins the loop and records the last time each
// live call was seen occupied.
func (a *App) startCallLog() error {
	svc := a.runtime.Services
	if svc == nil || svc.CallLog == nil {
		return nil
	}
	loopCtx, cancel := context.WithCancel(context.WithoutCancel(a.bgCtx))
	stop := svc.CallLog.StartCallLogWorker(loopCtx)
	a.onClose("call-log", func(ctx context.Context) error {
		stop(ctx)
		cancel()
		return nil
	})
	return nil
}
