package service

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

// apiWriteSpy counts the per-hash statements the API-token touch and the
// expired-session discard flushes issue.
type apiWriteSpy struct {
	Store
	touchCalls   map[string]int
	deleteCalls  map[string]int
	failDeletes  bool
	deleteFailed int
}

func (s *apiWriteSpy) TouchAPIToken(_ context.Context, hash string) error {
	s.touchCalls[hash]++
	return nil
}

func (s *apiWriteSpy) DeleteSession(_ context.Context, hash string) error {
	if s.failDeletes {
		s.deleteFailed++
		return errors.New("injected DeleteSession failure")
	}
	s.deleteCalls[hash]++
	return nil
}

func newAPIWriteBatch(t *testing.T) (*apiWriteSpy, *ConnWrites, *SessionService) {
	t.Helper()
	spy := &apiWriteSpy{Store: newTestDB(t), touchCalls: map[string]int{}, deleteCalls: map[string]int{}}
	w := NewConnWrites(spy)
	sessions := NewSessionService(spy)
	sessions.SetConnWrites(w)
	return spy, w, sessions
}

// 1,000 requests with one API token inside a flush window cost one store call,
// not 1,000 (ARCH-034's "at most one write per token per minute").
func TestConnWrites_APITokenTouchesCoalescePerInterval(t *testing.T) {
	spy, w, sessions := newAPIWriteBatch(t)
	ctx := context.Background()

	for range 1000 {
		if err := sessions.TouchAPIToken(ctx, "tok-a"); err != nil {
			t.Fatalf("TouchAPIToken: %v", err)
		}
	}
	if err := sessions.TouchAPIToken(ctx, "tok-b"); err != nil {
		t.Fatalf("TouchAPIToken: %v", err)
	}
	if len(spy.touchCalls) != 0 {
		t.Fatalf("touches wrote %v before the flush, want nothing", spy.touchCalls)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if spy.touchCalls["tok-a"] != 1 || spy.touchCalls["tok-b"] != 1 {
		t.Fatalf("flush calls = %v, want one per distinct token", spy.touchCalls)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("second Flush: %v", err)
	}
	if spy.touchCalls["tok-a"] != 1 {
		t.Fatalf("an empty flush wrote again: %v", spy.touchCalls)
	}
}

// A discard is queued, written once per distinct hash on flush, and kept for
// the next flush when the delete fails.
func TestConnWrites_DiscardsFlushAndRequeueOnFailure(t *testing.T) {
	spy, w, sessions := newAPIWriteBatch(t)
	ctx := context.Background()

	for i := range 3 {
		if err := sessions.DiscardSession(ctx, fmt.Sprintf("dead-%d", i%2)); err != nil {
			t.Fatalf("DiscardSession: %v", err)
		}
	}
	if len(spy.deleteCalls) != 0 {
		t.Fatalf("discards wrote %v before the flush, want nothing", spy.deleteCalls)
	}

	spy.failDeletes = true
	if err := w.Flush(ctx); err == nil {
		t.Fatal("Flush with a failing store returned nil")
	}
	if spy.deleteFailed != 2 {
		t.Fatalf("failed delete attempts = %d, want one per distinct hash (2)", spy.deleteFailed)
	}

	spy.failDeletes = false
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("retry Flush: %v", err)
	}
	if spy.deleteCalls["dead-0"] != 1 || spy.deleteCalls["dead-1"] != 1 {
		t.Fatalf("retry deletes = %v, want each hash once: a failed flush lost its hashes", spy.deleteCalls)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("third Flush: %v", err)
	}
	if spy.deleteCalls["dead-0"] != 1 {
		t.Fatalf("a flushed discard was written again: %v", spy.deleteCalls)
	}
}
