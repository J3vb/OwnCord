package app

import (
	"context"

	"github.com/J3vb/OwnCord/Server/service"
)

// installConnWrites batches the session touches and connection status stamps
// (P5-S07). Called from afterHubStart, before startHub registers the hub's own
// close, so the reverse walk closes this step AFTER the hub, and its final
// flush, which still runs before database.Close, writes the stamps queued
// before it runs. The hub's close step does not wait for the readPump defers
// that queue each connection's disconnect stamp, so the step first stamps
// every user the hub held when its stop began disconnected
// (Hub.StoppedUserIDs): a graceful stop leaves them offline with last_seen at
// stop time.
func (a *App) installConnWrites(services *service.Services) {
	if services == nil || services.Users == nil || services.Sessions == nil {
		return
	}
	w := services.BatchConnWrites()
	var connected func() []int64
	if a.hub != nil {
		connected = a.hub.StoppedUserIDs
	}
	a.onClose("conn-writes", startConnWrites(a.bgCtx, w, services.Users, connected))
}

// startConnWrites runs w's flush loop and returns its close step: stop the
// loop, queue a disconnect stamp for each user connected still reports, then
// flush what is pending (P5-S07). A nil connected stamps no one.
func startConnWrites(bgCtx context.Context, w *service.ConnWrites, users *service.UserService, connected func() []int64) func(context.Context) error {
	ctx, cancel := context.WithCancel(bgCtx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		w.Run(ctx)
	}()
	return func(ctx context.Context) error {
		cancel()
		<-done
		if connected != nil {
			for _, id := range connected() {
				// Batched, so this only queues and cannot fail.
				_ = users.StampDisconnect(ctx, id)
			}
		}
		return w.Flush(ctx)
	}
}
