package app

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// backgroundJobsGrace is how long the "background-jobs" close step lets
// running request-path jobs (a Web Push round) finish on their own before it
// cancels them. The rest of the step's budget is for the cancelled jobs to
// return.
const backgroundJobsGrace = 5 * time.Second

// startBackgroundJobs creates the group request-path jobs run on and
// registers its close step. startHub calls it after the mention-worker step.
func (a *App) startBackgroundJobs(rt api.Runtime) {
	// Request-path background jobs: push dispatch and the no-worker
	// mention write run on this group so shutdown can join them. Registered
	// after the mention worker, so the reverse walk runs it first, and before
	// the database closes. The group is rooted at WithoutCancel(bgCtx): the
	// event-persistence step cancels bgCtx earlier in the walk, and a group
	// that inherited that would cancel its jobs before they got their grace.
	a.background = syncutil.NewGroup(context.WithoutCancel(a.bgCtx))
	if rt.Services != nil && rt.Services.Messages != nil {
		rt.Services.Messages.SetBackground(a.background)
	}
	// Handed to the router (and from there to the update apply tail) through
	// the runtime, which startRouter reads after this step.
	a.runtime.Background = a.background
	a.runtime.Shutdown = a.shutdown
	a.onClose("background-jobs", func(ctx context.Context) error {
		if n := a.background.Stop(ctx, backgroundJobsGrace); n > 0 {
			// Not an error: failing the step would make a restarting process
			// exit non-zero (conn_writes.go). The job's later database call
			// fails against the closed pool.
			a.log.Warn("background jobs still running at shutdown, abandoning them", "count", n)
		}
		return nil
	})
}
