package app

import "context"

// startCallLog starts the DM call log worker after event persistence, so its
// recovery frames are persisted, and before the listener opens, so nobody is
// connected while leftover calls end. The loop context is deliberately not
// bgCtx: event persistence cancels bgCtx and the stop pass must still be able
// to write. The stop stamp relies on the voice grace keeping rows through hub-notice.
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
