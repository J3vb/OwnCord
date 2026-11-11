package syncutil

import (
	"context"
	"time"
)

// Group owns background jobs that outlive the request that spawned them, so a
// lifecycle owner can join them (or abandon them with a count) before their
// resources close.
//
// Go refuses new work once Stop has begun, under the same mutex that counts
// running jobs, so Add cannot race Wait as with a bare sync.WaitGroup. A nil
// *Group is usable: Go runs the job on a fresh, unowned group.
type Group struct {
	ctx    context.Context
	cancel context.CancelFunc

	// mu guards the fields below. It is a LEAF lock: never held across fn, I/O,
	// a channel operation or another lock.
	mu         Mutex
	draining   bool
	running    int
	idleClosed bool
	drain      chan struct{} // closed when Stop begins
	idle       chan struct{} // closed when running is zero while draining
}

// NewGroup returns a group whose jobs are cancelled when parent ends or Stop
// cancels them. Pass a context that outlives the owner's Stop, or jobs are
// cancelled before they get their grace.
func NewGroup(parent context.Context) *Group {
	ctx, cancel := context.WithCancel(parent)
	return &Group{
		ctx:    ctx,
		cancel: cancel,
		drain:  make(chan struct{}),
		idle:   make(chan struct{}),
	}
}

// Go runs fn on its own goroutine and reports whether it was admitted; once a
// drain has begun it returns false without running fn.
//
// fn receives ctx's values but not its cancellation: the job outlives its
// caller and ends when the group is cancelled. A job needing a deadline applies
// its own.
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

// closeIdleLocked closes idle once draining with nothing running; the caller holds mu.
func (g *Group) closeIdleLocked() {
	if g.draining && g.running == 0 && !g.idleClosed {
		g.idleClosed = true
		close(g.idle)
	}
}

// Draining is closed when Stop begins; a waiting job selects on it to abandon
// work the shutdown must not complete.
func (g *Group) Draining() <-chan struct{} {
	if g == nil {
		return nil
	}
	return g.drain
}

// Stop drains the group: close admission and Draining; wait up to grace for
// jobs to finish; cancel every job's context; wait until they finish or ctx is
// done. It returns how many jobs still run; a job ignoring cancellation is
// abandoned. Safe to call more than once and concurrently.
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
	// Whatever is left is abandoned; cancelling releases the group's context.
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
