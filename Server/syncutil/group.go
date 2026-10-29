package syncutil

import (
	"context"
	"time"
)

// Group owns background jobs that outlive the request or message that
// spawned them, so a lifecycle owner can join them (or abandon them with a
// count) before the resources they use are closed.
//
// It is the hub's "life plus WaitGroup" pattern with an admission gate: a
// bare sync.WaitGroup fed from handler goroutines would race Add against
// Wait, so Go refuses new work once Stop has begun, under the same mutex
// that counts running jobs.
//
// A nil *Group is usable: Go runs the job on a fresh, unowned group. Tests
// and the token CLI keep their old fire-and-forget behaviour that way, and
// no call site needs a bare go statement.
type Group struct {
	ctx    context.Context
	cancel context.CancelFunc

	// mu guards the fields below. It is a LEAF lock: it is never held across
	// fn, I/O, a channel operation or another lock, so it can be taken from
	// any call site whatever else that site holds.
	mu         Mutex
	draining   bool
	running    int
	idleClosed bool
	drain      chan struct{} // closed when Stop begins
	idle       chan struct{} // closed when running is zero while draining
}

// NewGroup returns a group whose jobs are cancelled when parent ends or Stop
// cancels them. Pass a context that does not die before the owner's Stop
// (typically context.WithoutCancel of a longer-lived context), or the jobs
// are cancelled before Stop can give them their grace.
func NewGroup(parent context.Context) *Group {
	ctx, cancel := context.WithCancel(parent)
	return &Group{
		ctx:    ctx,
		cancel: cancel,
		drain:  make(chan struct{}),
		idle:   make(chan struct{}),
	}
}

// Go runs fn on its own goroutine and reports whether it was admitted. It
// returns false, without running fn, once a drain has begun.
//
// fn receives ctx's values but not its cancellation: the job outlives its
// caller (a request context is cancelled the moment the response is
// written), and ends when the group is cancelled instead. A job that needs a
// deadline applies its own inside fn. The pattern is ws/hub_sweep.go's
// sweepTailCtx, and it keeps logctx values and contextcheck intact.
func (g *Group) Go(ctx context.Context, fn func(context.Context)) bool {
	if g == nil {
		g = NewGroup(context.WithoutCancel(ctx))
	}
	g.mu.Lock()
	if g.draining {
		g.mu.Unlock()
		return false
	}
	g.running++
	g.mu.Unlock()

	jobCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	stop := context.AfterFunc(g.ctx, cancel) //nolint:contextcheck // g.ctx is the group's own lifecycle: the job ends when the group is cancelled, not when its caller is.
	go func(jobCtx context.Context) {
		defer g.finish()
		defer cancel()
		defer stop()
		fn(jobCtx)
	}(jobCtx)
	return true
}

// finish records one job's exit and, on the last one of a drain, wakes Stop.
func (g *Group) finish() {
	g.mu.Lock()
	g.running--
	g.closeIdleLocked()
	g.mu.Unlock()
}

// closeIdleLocked closes idle once a drain has begun and nothing runs. The
// caller holds mu.
func (g *Group) closeIdleLocked() {
	if g.draining && g.running == 0 && !g.idleClosed {
		g.idleClosed = true
		close(g.idle)
	}
}

// Draining is closed when Stop begins. A job that waits (a countdown, a
// backoff) selects on it to abandon work the shutdown must not complete.
func (g *Group) Draining() <-chan struct{} {
	if g == nil {
		return nil
	}
	return g.drain
}

// Stop drains the group, in this order: close admission and Draining; wait up
// to grace for running jobs to finish on their own; cancel every job's
// context; wait until they finish or ctx is done. It returns how many jobs
// are still running, which the caller logs. A job that ignores cancellation
// is abandoned, not waited for. Stop starts no goroutine, and is safe to call
// more than once and concurrently.
func (g *Group) Stop(ctx context.Context, grace time.Duration) (stragglers int) {
	if g == nil {
		return 0
	}
	g.mu.Lock()
	if !g.draining {
		g.draining = true
		close(g.drain)
	}
	g.closeIdleLocked()
	g.mu.Unlock()
	// Whatever is left is abandoned, so cancelling on the way out is right
	// for the stragglers too, and releases the group's context.
	defer g.cancel()

	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-g.idle:
		return 0
	case <-timer.C:
	case <-ctx.Done():
	}

	g.cancel()
	select {
	case <-g.idle:
	case <-ctx.Done():
	}

	g.mu.Lock()
	stragglers = g.running
	g.mu.Unlock()
	return stragglers
}
