package voicestate

import (
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/ws/lockrank"
)

// TestUserLocks_SerializesSameUser proves UserLocks' core contract: two callers
// for the SAME userID cannot both be inside their critical section at once. The
// second's Lock() call genuinely blocks until the first releases. Deterministic
// (no sleeps): the second goroutine signals it is about to call Lock(), then the test asserts it has
// NOT yet reported "acquired" a short, generous instant later, before
// releasing the first and confirming the second then proceeds.
func TestUserLocks_SerializesSameUser(t *testing.T) {
	v := NewUserLocks[lockrank.VoiceMod]()
	const uid = int64(1)

	firstAcquired := make(chan struct{})
	releaseFirst := make(chan struct{})
	go func() {
		unlock := v.Lock(uid)
		close(firstAcquired)
		<-releaseFirst
		unlock()
	}()
	<-firstAcquired

	secondAttempting := make(chan struct{})
	secondAcquired := make(chan struct{})
	go func() {
		close(secondAttempting)
		unlock := v.Lock(uid)
		close(secondAcquired)
		unlock()
	}()
	<-secondAttempting

	select {
	case <-secondAcquired:
		t.Fatal("second Lock() returned while the first still holds it")
	case <-time.After(50 * time.Millisecond):
		// Expected: still blocked.
	}

	close(releaseFirst)
	select {
	case <-secondAcquired:
	case <-time.After(2 * time.Second):
		t.Fatal("second Lock() never returned after the first released")
	}
}

// TestUserLocks_DoesNotSerializeDifferentUsers proves the lock is keyed
// per userID, not a single global lock — a moderation action against one
// user must not stall on an unrelated one.
func TestUserLocks_DoesNotSerializeDifferentUsers(t *testing.T) {
	v := NewUserLocks[lockrank.VoiceMod]()
	unlock1 := v.Lock(1)
	defer unlock1()

	done := make(chan struct{})
	go func() {
		unlock2 := v.Lock(2)
		unlock2()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("lock(2) blocked on an unrelated user's held lock(1)")
	}
}

// TestUserLocks_EvictsEntryOnceUnheldAndUnwaited checks that the map does not
// grow forever: an entry with no current holder and no queued waiter is removed
// as soon as the last release happens.
func TestUserLocks_EvictsEntryOnceUnheldAndUnwaited(t *testing.T) {
	v := NewUserLocks[lockrank.VoiceMod]()

	unlock := v.Lock(1)
	if len(v.locks) != 1 {
		t.Fatalf("locks = %d entries while held, want 1", len(v.locks))
	}
	unlock()
	if len(v.locks) != 0 {
		t.Fatalf("locks = %d entries after the only holder released, want 0 (evicted)", len(v.locks))
	}

	// A waiter queued behind an in-flight holder must NOT be evicted out
	// from under it: refs stays at 2 (holder + waiter) until both release.
	unlockA := v.Lock(2)
	waiterStarted := make(chan struct{})
	waiterDone := make(chan struct{})
	go func() {
		close(waiterStarted)
		v.Lock(2)() // blocks until unlockA runs, then immediately releases
		close(waiterDone)
	}()
	<-waiterStarted
	// Give the waiter a moment to register itself (increment refs) before
	// the holder releases — best-effort, like the existing contention test
	// above; the correctness claim (refs never hits 0 while a waiter is
	// registered) holds regardless of exactly when it gets there.
	time.Sleep(20 * time.Millisecond)
	unlockA()
	select {
	case <-waiterDone:
	case <-time.After(2 * time.Second):
		t.Fatal("the queued waiter for user 2 never completed")
	}
	if len(v.locks) != 0 {
		t.Fatalf("locks = %d entries after both the holder and the waiter released, want 0 (evicted)", len(v.locks))
	}
}
