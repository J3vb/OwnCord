package ws

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// Stop signals Run to exit.
func (h *Hub) Stop() {
	h.lifecycle.stopOnce.Do(h.closeStop)
}

// initLife makes the lifecycle context and the background group rooted at it; NewHub calls it once,
// before any goroutine can reach the hub.
func (h *Hub) initLife() {
	h.lifecycle.ctx, h.lifecycle.cancel = context.WithCancel(context.Background())
	// WithoutCancel: closeStop must not cancel a LiveKit removal mid-request (that leaves a ghost
	// participant); JoinBackground gives jobs a short grace, then cancels.
	h.lifecycle.background = syncutil.NewGroup(context.WithoutCancel(h.lifecycle.ctx))
}

// closeStop signals Run to exit and cancels in-flight sweeps; only run under stopOnce.
func (h *Hub) closeStop() {
	close(h.stop)
	h.stopThreadFeed()
	if h.lifecycle.cancel != nil {
		h.lifecycle.cancel()
	}
}

// finishRun closes runDone once every sweep Run started has returned. A method, not a closure, so
// Run's dispatch loop stays Run.func1, the name the api suite's goleak filter ignores.
func (h *Hub) finishRun() {
	h.closeParkedBarriers()
	h.lifecycle.sweeps.Wait()
	close(h.lifecycle.runDone)
}

// Done closes once Run has returned, DispatchAlive is false and every sweep finished. Stop and
// GracefulStopContext do not wait for that; a caller that must know the loop is gone waits here.
func (h *Hub) Done() <-chan struct{} {
	return h.lifecycle.runDone
}

const backgroundJoinGrace = 2 * time.Second

// JoinBackground waits for the voice-leave jobs the hub spawned (LiveKit participant removal,
// voice-state delete retries), refuses new ones, and returns how many were still running when ctx
// ended. closeStop does not cancel them (an in-flight removal should finish rather than leave a
// ghost participant): they get backgroundJoinGrace, are then cancelled, and are waited for until
// ctx ends. A job spawned during stop is either joined here or refused, never left running.
// stopHub calls it after Done, not finishRun: that would hold the dispatch goroutine's exit on a
// job that may need a user lock. No hub lock is held here.
func (h *Hub) JoinBackground(ctx context.Context) (stragglers int) {
	return h.lifecycle.background.Stop(ctx, backgroundJoinGrace)
}
