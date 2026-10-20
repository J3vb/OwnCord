package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// Stop signals Run to exit. Safe to call multiple times.
func (h *Hub) Stop() {
	h.stopOnce.Do(h.closeStop)
}

// initLife makes the hub's lifecycle context and the background group rooted
// at it. NewHub calls it once, before any goroutine can reach the hub.
func (h *Hub) initLife() {
	h.life, h.stopLife = context.WithCancel(context.Background())
	h.background = syncutil.NewGroup(h.life)
}

// closeStop signals Run to exit and cancels the in-flight sweeps. Only ever
// run under stopOnce.
func (h *Hub) closeStop() {
	close(h.stop)
	if h.stopLife != nil {
		h.stopLife()
	}
}

// finishRun closes runDone once every sweep Run started has returned. A
// method, not a closure in Run, so Run's dispatch loop stays Run.func1 — the
// name the api suite's goleak filter ignores.
func (h *Hub) finishRun() {
	h.closeParkedBarriers()
	h.sweeps.Wait()
	close(h.runDone)
}

// Done returns a channel that closes once Run has returned, with
// DispatchAlive already false and every sweep Run started finished. Stop and
// GracefulStopContext do not wait for that, so a caller that must know the
// loop is gone waits here.
func (h *Hub) Done() <-chan struct{} {
	return h.runDone
}

// JoinBackground waits for the voice-leave jobs the hub spawned (the LiveKit
// participant removal and the voice-state delete retries), refuses new ones,
// and returns how many were still running when ctx ended. The jobs are
// cancelled together with the hub (closeStop cancels life), so on a stopped
// hub this only waits for them to return; they get no extra grace. A job
// spawned while the hub is stopping is therefore either joined here or
// refused by the group, never left running after this returns.
//
// stopHub calls it after Done. It is not part of finishRun: that would hold
// the dispatch goroutine's exit on a job that may need a user lock. No hub
// lock is held here.
func (h *Hub) JoinBackground(ctx context.Context) (stragglers int) {
	return h.background.Stop(ctx, 0)
}
