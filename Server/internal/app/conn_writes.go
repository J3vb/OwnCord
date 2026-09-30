package app

import (
	"context"

	"github.com/J3vb/OwnCord/Server/service"
)

// installConnWrites batches the session touches and connection status stamps
// (P5-S07). Called from afterHubStart, before startHub registers the hub's own
// close, so the reverse walk closes this step AFTER the hub, and its final
// flush, which still runs before database.Close, writes the stamps queued
// before it runs. A disconnect stamp a connection's readPump defer queues
// after that is lost like a crash, and the boot-time ResetAllUserStatuses
// clears the "online" it leaves.
func (a *App) installConnWrites(services *service.Services) {
	if services == nil || services.Users == nil || services.Sessions == nil {
		return
	}
	w := services.BatchConnWrites()
	a.onClose("conn-writes", startConnWrites(a.bgCtx, w))
}

// startConnWrites runs w's flush loop and returns its close step: stop the
// loop, then flush what is still pending (P5-S07).
func startConnWrites(bgCtx context.Context, w *service.ConnWrites) func(context.Context) error {
	ctx, cancel := context.WithCancel(bgCtx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		w.Run(ctx)
	}()
	return func(ctx context.Context) error {
		cancel()
		<-done
		return w.Flush(ctx)
	}
}
