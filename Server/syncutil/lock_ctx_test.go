package syncutil

import (
	"context"
	"errors"
	"testing"
	"time"
)

// holdLock takes mu on another goroutine (the deadlock build flags a lock
// retaken by its own holder) and returns the function that releases it.
func holdLock(t *testing.T, mu *Mutex) (release func()) {
	t.Helper()
	locked := make(chan struct{})
	rel := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		mu.Lock()
		close(locked)
		<-rel
		mu.Unlock()
	}()
	<-locked
	var released bool
	release = func() {
		if !released {
			released = true
			close(rel)
			<-done
		}
	}
	t.Cleanup(release)
	return release
}

func TestLockContext_AcquiresFreeLock(t *testing.T) {
	var mu Mutex
	if err := LockContext(context.Background(), &mu); err != nil {
		t.Fatalf("LockContext: %v", err)
	}
	mu.Unlock()
}

func TestLockContext_AcquiresWhenReleased(t *testing.T) {
	var mu Mutex
	release := holdLock(t, &mu)
	go func() {
		time.Sleep(20 * time.Millisecond)
		release()
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := LockContext(ctx, &mu); err != nil {
		t.Fatalf("LockContext: %v", err)
	}
	mu.Unlock()
}

func TestLockContext_ReturnsOnDeadlineWithoutLock(t *testing.T) {
	var mu Mutex
	release := holdLock(t, &mu)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	err := LockContext(ctx, &mu)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want DeadlineExceeded", err)
	}
	release()
	if !mu.TryLock() {
		t.Fatal("lock taken by an abandoned LockContext")
	}
	mu.Unlock()
}
