package app

import (
	"context"
	"fmt"
	"time"
)

const threadArchiverJoinBudget = 5 * time.Second

// startThreadArchiver runs one synchronous sweep so threads that came due while
// the server was down are archived before the listener opens, then runs the
// loop on bgCtx, joined within threadArchiverJoinBudget.
func (a *App) startThreadArchiver() error {
	svc := a.runtime.Services
	if svc == nil || svc.ThreadArchiver == nil {
		return nil
	}
	archiver := svc.ThreadArchiver
	if err := archiver.Sweep(a.bgCtx); err != nil {
		a.log.Warn("thread-archiver: boot sweep failed", "err", err)
	}
	ctx, cancel := context.WithCancel(a.bgCtx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		archiver.Run(ctx)
	}()
	a.onCloseWithin("thread-archiver", threadArchiverJoinBudget, func(closeCtx context.Context) error {
		cancel()
		select {
		case <-done:
			return nil
		case <-closeCtx.Done():
			return fmt.Errorf("thread archiver did not exit: %w", closeCtx.Err())
		}
	})
	return nil
}
