package app

import (
	"context"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/service"
)

// afterHubStart wires what needs the built runtime: the log-level card, the
// boot-status record, then the batched connection writes.
func (a *App) afterHubStart(services *service.Services) {
	if a.deps.LogLevelVar != nil {
		lvl := admin.NewLogLevelController(a.deps.LogLevelVar, a.deps.LogBaseLevel)
		a.runtime.LogLevel = lvl
		a.onClose("log-level", func(context.Context) error {
			lvl.Close()
			return nil
		})
	}
	a.recordBootStatus(services)
	a.installConnWrites(services)
}
