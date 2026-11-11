package app

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/service"
)

// installConnWrites batches session touches and connection status stamps. Its
// flush runs after the hub's close and before database.Close. The hub's close does not wait for readPump
// defers, so it first stamps Hub.StoppedUserIDs as disconnected.
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

// startConnWrites runs w's flush loop and returns its close step. When dbClosed
// reports the handle already closed (a backup restore), pending writes are
// dropped: failing the step would make the restarting process exit non-zero.
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
