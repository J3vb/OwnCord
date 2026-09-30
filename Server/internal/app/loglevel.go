package app

import (
	"context"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/service"
)

// afterHubStart runs the wiring that needs the built runtime: the admin
// panel's runtime log-level card (SRE-07), then the boot-status record. It
// lives beside the controller so lifecycle.go keeps its file-size budget.
//
// A nil LevelVar (an App built without main's wiring, as some tests do)
// leaves api.Runtime.LogLevel nil, which the admin endpoints report as 503.
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
}
