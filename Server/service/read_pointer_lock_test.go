package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// MoveReadPointer waits for mentionEmitMu only until its context ends: a
// holder stalled on a long-lived context must not park the caller past its
// deadline, and the abandoned wait must not leave the lock taken.
func TestMoveReadPointer_LockWaitHonoursContext(t *testing.T) {
	svc, _, _ := newMentionFixture(t)

	// Held from another goroutine, as the mention worker holds it (the deadlock
	// build flags a lock retaken by its own holder).
	locked := make(chan struct{})
	release := make(chan struct{})
	held := make(chan struct{})
	go func() {
		defer close(held)
		svc.mentionEmitMu.Lock()
		close(locked)
		<-release
		svc.mentionEmitMu.Unlock()
	}()
	<-locked
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := svc.MoveReadPointer(ctx, 2, 10, db.ReadAtLatest, 0)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want context.DeadlineExceeded", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("returned after %v, want about the 50ms deadline", elapsed)
	}
	close(release)
	<-held

	if _, err := svc.MoveReadPointer(context.Background(), 2, 10, db.ReadAtLatest, 0); err != nil {
		t.Fatalf("MoveReadPointer after release: %v", err)
	}
}
