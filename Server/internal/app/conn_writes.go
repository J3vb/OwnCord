package app

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/service"
)

// installConnWrites batches the session touches and connection status stamps.
// It is called from afterHubStart before startHub registers the hub's own close,
// so the reverse walk closes this step after the hub, and its final flush
// (still before database.Close) writes the stamps queued before it runs. The
// hub's close step does not wait for the readPump defers that queue each
// disconnect stamp, so this step first stamps every user the hub held when its
// stop began as disconnected (Hub.StoppedUserIDs): a graceful stop leaves them
// offline with last_seen at stop time.
func (a *App) installConnWrites(services *service.Services) {
	if services == nil || services.Users == nil || services.Sessions == nil {
		return
	}
	w := services.BatchConnWrites()
	var connected func() []int64
	if a.hub != nil {
		connected = a.hub.StoppedUserIDs
	}
	var dbClosed func() bool
	if a.database != nil {
		dbClosed = a.database.Closed
	}
	a.onClose("conn-writes", startConnWrites(a.bgCtx, w, services.Users, connected, dbClosed))
}

// startConnWrites runs w's flush loop and returns its close step: stop the
// loop, queue a disconnect stamp for each user connected still reports, then
// flush what is pending. A nil connected stamps no one. When dbClosed reports
// the handle already closed (a backup restore closes it before the restart),
// the pending writes cannot land and are dropped: failing the step would make
// the restarting process exit non-zero.
func startConnWrites(bgCtx context.Context, w *service.ConnWrites, users *service.UserService, connected func() []int64, dbClosed func() bool) func(context.Context) error {
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
		if dbClosed != nil && dbClosed() {
			slog.Warn("conn-writes: database already closed, dropping pending session touches and connection stamps")
			return nil
		}
		return w.Flush(ctx)
	}
}
