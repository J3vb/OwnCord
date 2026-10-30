package app

import "context"

// startCallLog starts the DM call log worker. It runs after event persistence
// so the frames its start-up recovery emits are persisted for replay, and
// before the http stage opens the listener, so nobody is connected while
// leftover calls from the previous run are ended.
//
// The loop context is deliberately not bgCtx: the event-persistence close step
// cancels bgCtx and the stop pass must still be able to write. This step's
// close runs before that one under its own bounded context. The stop func joins
// the loop and stamps last_seen_at on live calls; the stamp for a room with
// someone in it relies on the voice grace keeping the voice rows of dropped
// connections through the hub-notice step, which closes before this one.
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
