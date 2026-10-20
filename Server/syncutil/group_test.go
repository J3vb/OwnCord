package syncutil

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type groupCtxKey struct{}

func TestGroup_StopWaitsForAdmittedWork(t *testing.T) {
	g := NewGroup(context.Background())
	release := make(chan struct{})
	var finished atomic.Bool
	if !g.Go(context.Background(), func(context.Context) {
		<-release
		finished.Store(true)
	}) {
		t.Fatal("Go refused work on a live group")
	}

	go func() {
		time.Sleep(20 * time.Millisecond)
		close(release)
	}()
	if n := g.Stop(context.Background(), 5*time.Second); n != 0 {
		t.Errorf("Stop stragglers = %d, want 0", n)
	}
	if !finished.Load() {
		t.Error("Stop returned before the admitted job finished")
	}
	select {
	case <-g.Draining():
	default:
		t.Error("Draining is not closed after Stop")
	}
}

// Edge case 1: a spawner racing Stop is refused cleanly, never admitted
// after the drain, and every admitted job is joined.
func TestGroup_GoDuringStopIsRefused(t *testing.T) {
	g := NewGroup(context.Background())
	var ran, admitted atomic.Int64
	var wg sync.WaitGroup
	stopSpawn := make(chan struct{})
	for range 4 {
		wg.Go(func() {
			for {
				select {
				case <-stopSpawn:
					return
				default:
				}
				if g.Go(context.Background(), func(context.Context) {
					time.Sleep(time.Millisecond)
					ran.Add(1)
				}) {
					admitted.Add(1)
				}
			}
		})
	}
	time.Sleep(20 * time.Millisecond)
	if n := g.Stop(context.Background(), 5*time.Second); n != 0 {
		t.Errorf("Stop stragglers = %d, want 0", n)
	}
	// Nothing admitted may run after Stop returned: the count is final.
	got := ran.Load()
	if got != admitted.Load() {
		t.Errorf("ran %d jobs, admitted %d: a job was lost or admitted after the drain", got, admitted.Load())
	}
	if g.Go(context.Background(), func(context.Context) { t.Error("refused job ran") }) {
		t.Error("Go admitted work after Stop")
	}
	close(stopSpawn)
	wg.Wait()
	time.Sleep(10 * time.Millisecond)
	if ran.Load() != got {
		t.Errorf("a job ran after Stop returned: %d -> %d", got, ran.Load())
	}
}

func TestGroup_StopCancelsAfterGrace(t *testing.T) {
	g := NewGroup(context.Background())
	started := make(chan struct{})
	var cancelled atomic.Bool
	g.Go(context.Background(), func(ctx context.Context) {
		close(started)
		<-ctx.Done()
		cancelled.Store(true)
	})
	<-started

	const grace = 50 * time.Millisecond
	begin := time.Now()
	n := g.Stop(context.Background(), grace)
	elapsed := time.Since(begin)
	if n != 0 {
		t.Errorf("Stop stragglers = %d, want 0 (the job honours cancellation)", n)
	}
	if !cancelled.Load() {
		t.Error("job ctx was not cancelled")
	}
	if elapsed < grace || elapsed > 2*time.Second {
		t.Errorf("Stop took %v, want about the %v grace", elapsed, grace)
	}
}

// Edge case 2: a job that ignores cancellation is reported at the deadline.
func TestGroup_StopReturnsStragglersAtDeadline(t *testing.T) {
	g := NewGroup(context.Background())
	release := make(chan struct{})
	defer close(release)
	started := make(chan struct{})
	g.Go(context.Background(), func(context.Context) {
		close(started)
		<-release
	})
	<-started

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	begin := time.Now()
	if n := g.Stop(ctx, 10*time.Millisecond); n != 1 {
		t.Errorf("Stop stragglers = %d, want 1", n)
	}
	if elapsed := time.Since(begin); elapsed > 2*time.Second {
		t.Errorf("Stop took %v, want about the ctx deadline", elapsed)
	}
}

func TestGroup_JobCtxKeepsValuesNotCallerCancellation(t *testing.T) {
	g := NewGroup(context.Background())
	caller, cancelCaller := context.WithCancel(context.WithValue(context.Background(), groupCtxKey{}, "v"))
	type seen struct {
		val any
		err error
	}
	got := make(chan seen, 1)
	proceed := make(chan struct{})
	g.Go(caller, func(ctx context.Context) {
		<-proceed
		got <- seen{ctx.Value(groupCtxKey{}), ctx.Err()}
	})
	cancelCaller()
	close(proceed)
	jobSeen := <-got
	if jobSeen.val != "v" {
		t.Error("job ctx lost the caller's values")
	}
	if err := jobSeen.err; err != nil {
		t.Errorf("job ctx follows the caller's cancellation: %v", err)
	}
	g.Stop(context.Background(), time.Second)

	// A second job: caller cancelled before it starts must still run live.
	g2 := NewGroup(context.Background())
	c2, cancel2 := context.WithCancel(context.Background())
	cancel2()
	live := make(chan error, 1)
	g2.Go(c2, func(ctx context.Context) { live <- ctx.Err() })
	if err := <-live; err != nil {
		t.Errorf("job ctx follows the caller's cancellation: %v", err)
	}
	g2.Stop(context.Background(), time.Second)
}

func TestGroup_NilGroupRunsJob(t *testing.T) {
	var g *Group
	done := make(chan struct{})
	if !g.Go(context.Background(), func(context.Context) { close(done) }) {
		t.Fatal("nil group refused work")
	}
	<-done
	if n := g.Stop(context.Background(), time.Millisecond); n != 0 {
		t.Errorf("nil Stop = %d", n)
	}
}

func TestGroup_ParentCancelCancelsJobs(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	g := NewGroup(parent)
	ended := make(chan struct{})
	g.Go(context.Background(), func(ctx context.Context) {
		<-ctx.Done()
		close(ended)
	})
	cancel()
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("parent cancellation did not reach the job")
	}
	g.Stop(context.Background(), time.Second)
}
