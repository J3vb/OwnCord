package service

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestSleepOrDoneReturnsOnCancel(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	sleepOrDone(ctx, time.Hour)
	if time.Since(start) > time.Second {
		t.Error("sleepOrDone ignored a cancelled context")
	}
	start = time.Now()
	sleepOrDone(context.Background(), 5*time.Millisecond)
	if time.Since(start) < 4*time.Millisecond {
		t.Error("sleepOrDone returned before its delay")
	}
}

func TestDueSleepClampsToZeroAndTheCap(t *testing.T) {
	t.Parallel()
	now := time.Unix(1000, 0)
	if got := dueSleep(now.Add(-time.Minute), now, time.Second, time.Hour); got != 0 {
		t.Errorf("past due = %v, want 0", got)
	}
	if got := dueSleep(now.Add(time.Minute), now, time.Second, time.Hour); got != time.Minute+time.Second {
		t.Errorf("due in a minute = %v, want 1m1s", got)
	}
	if got := dueSleep(now.Add(2*time.Hour), now, 0, time.Hour); got != time.Hour {
		t.Errorf("far due = %v, want the cap", got)
	}
}

// A failed sweep is reported and retried after retryAfter; a failed read skips
// the sweep; cancelling ctx ends the loop.
func TestRunDueLoopReportsSweepErrorsAndStopsOnCancel(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	var reads, sweeps, reported atomic.Int32
	boom := errors.New("boom")
	next := func(context.Context) (time.Duration, bool) {
		return time.Millisecond, reads.Add(1) == 1
	}
	sweep := func(context.Context) error {
		if sweeps.Add(1) >= 3 {
			cancel()
		}
		return boom
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		runDueLoop(ctx, nil, next, sweep, time.Millisecond, func(err error) {
			if errors.Is(err, boom) {
				reported.Add(1)
			}
		})
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("runDueLoop did not stop after cancel")
	}
	if sweeps.Load() < 3 || reads.Load() < 4 {
		t.Errorf("sweeps %d reads %d; want the failed read skipped and three sweeps", sweeps.Load(), reads.Load())
	}
	if reported.Load() != 2 {
		t.Errorf("reported %d sweep errors; want 2 (the third ended with ctx cancelled)", reported.Load())
	}
}
