package db

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestOptimizeLoop_RunsThenStopsOnCancel(t *testing.T) {
	var runs atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := runOptimizeLoop(ctx, 5*time.Millisecond, func(context.Context) error {
		runs.Add(1)
		return errors.New("boom") // a failure is logged and the loop continues
	}, func() bool { return false })

	deadline := time.Now().Add(5 * time.Second)
	for runs.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	if runs.Load() < 2 {
		t.Fatalf("optimize ran %d times, want >= 2 despite failures", runs.Load())
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("loop did not exit on cancel")
	}
	n := runs.Load()
	time.Sleep(30 * time.Millisecond)
	if runs.Load() != n {
		t.Fatal("optimize ran after cancel")
	}
}

func TestOptimizeLoop_ExitsWhenClosed(t *testing.T) {
	var closed atomic.Bool
	var runs atomic.Int32
	done := runOptimizeLoop(context.Background(), 5*time.Millisecond, func(context.Context) error {
		runs.Add(1)
		return nil
	}, closed.Load)
	closed.Store(true)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("loop did not exit after the database closed")
	}
}

func TestDBOptimize_RunsAndIsNoOpAfterClose(t *testing.T) {
	database, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Optimize(context.Background()); err != nil {
		t.Fatalf("Optimize: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if err := database.Optimize(context.Background()); err != nil {
		t.Fatalf("Optimize after Close must be a no-op, got %v", err)
	}
}

func TestStatsCaches_ServeWithinTTLAndRefreshAfter(t *testing.T) {
	database := openMigratedMemoryInternal(t)
	ctx := context.Background()
	now := time.Unix(5000, 0)
	clock := func() time.Time { return now }
	database.activeMessagesCache.Now = clock
	database.attachmentBytesCache.Now = clock

	uid, err := database.CreateUser(ctx, "cachey", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	chID, err := database.CreateChannel(ctx, "cache-chan", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	stats, err := database.GetServerStats(ctx)
	if err != nil || stats.MessageCount != 0 {
		t.Fatalf("initial: %v %+v", err, stats)
	}
	if _, err := database.CreateMessage(ctx, chID, uid, "hi", nil); err != nil {
		t.Fatal(err)
	}
	now = now.Add(30 * time.Second)
	if stats, _ = database.GetServerStats(ctx); stats.MessageCount != 0 {
		t.Fatalf("within TTL the cached count must be served, got %d", stats.MessageCount)
	}
	now = now.Add(31 * time.Second)
	if stats, _ = database.GetServerStats(ctx); stats.MessageCount != 1 {
		t.Fatalf("after TTL the count must refresh, got %d", stats.MessageCount)
	}

	// An erroring query is returned and not cached.
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	now = now.Add(2 * time.Minute)
	if _, err := database.TotalAttachmentBytes(cctx); err == nil {
		t.Fatal("expected an error from a cancelled context")
	}
	if n, err := database.TotalAttachmentBytes(ctx); err != nil || n != 0 {
		t.Fatalf("after a failed query the next call must retry: %d %v", n, err)
	}
}
