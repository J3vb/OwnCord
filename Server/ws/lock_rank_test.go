//go:build deadlock

package ws

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// These tests drive the deadlock build's rank checker (syncutil/ranked_deadlock.go)
// through the hub's real lock fields, so a rank type moved in lock_order.go
// moves the expectation with it.

// rankPanic runs fn and returns the rank-violation report it panicked with,
// or "" when it returned normally.
func rankPanic(t *testing.T, fn func()) (report string) {
	t.Helper()
	defer func() {
		if r := recover(); r != nil {
			syncutil.TakeRankViolations()
			report = fmt.Sprint(r)
			if !strings.Contains(report, "lock rank violation") {
				t.Fatalf("panicked with something other than a rank violation: %v", r)
			}
		}
	}()
	fn()
	return ""
}

// wantBothStacks checks a report names both ranks and carries both stacks,
// each reaching back to the test that took the lock.
func wantBothStacks(t *testing.T, report, acquiring, held, test string) {
	t.Helper()
	if report == "" {
		t.Fatalf("no rank violation; want %s acquired under %s to panic", acquiring, held)
	}
	for _, s := range []string{"acquiring ws." + acquiring, "holding", "ws." + held, "acquire stack:", "held lock acquired at:"} {
		if !strings.Contains(report, s) {
			t.Errorf("report lacks %q:\n%s", s, report)
		}
	}
	acq, heldPart, _ := strings.Cut(report, "held lock acquired at:")
	if !strings.Contains(acq, test) || !strings.Contains(heldPart, test) {
		t.Errorf("each stack must reach %s:\n%s", test, report)
	}
}

func TestRank_AllowsOutermostFirst(t *testing.T) {
	h := &Hub{voiceMod: newUserLocks[lockRankVoiceMod]()}
	ps := &PubSub{}
	c := &Client{}
	if r := rankPanic(t, func() {
		unlockMember := h.voiceReg.voiceMember.lock(1) // 1
		unlockMod := h.voiceMod.lock(1)                // 2
		h.tombstones.mu.Lock()                         // 3
		h.presenceMu.Lock()                            // 4
		h.seqMu.Lock()                                 // 5
		h.keyHolderMu.RLock()                          // 6
		h.mu.RLock()                                   // 7
		ps.mu.RLock()                                  // 8
		lockOnce(&c.mu)                                // 9
		ps.mu.RUnlock()
		h.mu.RUnlock()
		h.keyHolderMu.RUnlock()
		h.seqMu.Unlock()
		h.presenceMu.Unlock()
		h.tombstones.mu.Unlock()
		unlockMod()
		unlockMember()
	}); r != "" {
		t.Fatalf("the documented order panicked:\n%s", r)
	}
	// Released in order, the outermost lock is free to take again.
	if r := rankPanic(t, func() { h.voiceReg.voiceMember.lock(1)() }); r != "" {
		t.Fatalf("a lock taken after every hold was released panicked:\n%s", r)
	}
}

func TestRank_PanicsOnInversion(t *testing.T) {
	h := &Hub{}
	c := &Client{}

	c.mu.Lock()
	r := rankPanic(t, func() { h.mu.RLock() })
	c.mu.Unlock()
	wantBothStacks(t, r, "lockRankHub (rank 7)", "lockRankLeaf (rank 9)", "TestRank_PanicsOnInversion")

	h.seqMu.Lock()
	r = rankPanic(t, func() { h.voiceReg.voiceMember.lock(1)() })
	h.seqMu.Unlock()
	wantBothStacks(t, r, "lockRankVoiceMember (rank 1)", "lockRankSeq (rank 5)", "TestRank_PanicsOnInversion")

	// The refused acquire took nothing, so the lock is free afterwards.
	if r := rankPanic(t, func() { lockOnce(&h.mu) }); r != "" {
		t.Fatalf("a refused acquire left a hold behind:\n%s", r)
	}
}

func TestRank_PanicsOnTwoOfSameRank(t *testing.T) {
	var reg voiceRegistry
	unlock := reg.voiceMember.lock(1)
	r := rankPanic(t, func() { reg.voiceMember.lock(2)() })
	unlock()
	wantBothStacks(t, r, "lockRankVoiceMember (rank 1)", "lockRankVoiceMember (rank 1)", "TestRank_PanicsOnTwoOfSameRank")

	a, b := &Client{}, &Client{}
	a.mu.Lock()
	r = rankPanic(t, func() { b.mu.Lock() })
	a.mu.Unlock()
	wantBothStacks(t, r, "lockRankLeaf (rank 9)", "lockRankLeaf (rank 9)", "TestRank_PanicsOnTwoOfSameRank")

	// A recursive read lock is two holds of one rank too: it deadlocks once a
	// writer queues between the two.
	h := &Hub{}
	h.mu.RLock()
	r = rankPanic(t, func() { h.mu.RLock() })
	h.mu.RUnlock()
	if !strings.Contains(r, "this same lock") {
		t.Errorf("a recursive RLock should be reported as the same lock:\n%s", r)
	}
}

func TestRank_TryLockNotFlagged(t *testing.T) {
	h := &Hub{voiceMod: newUserLocks[lockRankVoiceMod]()}
	c := &Client{}

	// A cold read's TryRLock of the tombstones (rank 3) under seqMu (5)
	// cannot block, so it is not flagged.
	h.seqMu.Lock()
	var got bool
	if r := rankPanic(t, func() { got = h.tombstones.mu.TryRLock() }); r != "" || !got {
		t.Fatalf("TryRLock under a later rank: ok=%v, report:\n%s", got, r)
	}
	h.seqMu.Unlock()

	// It is still a hold: a blocking acquire of rank 3 under it is flagged.
	r := rankPanic(t, func() { c.focusMu.Lock() })
	wantBothStacks(t, r, "lockRankSerialiser (rank 3)", "lockRankSerialiser (rank 3)", "TestRank_TryLockNotFlagged")
	if !strings.Contains(r, "via TryRLock") {
		t.Errorf("report should say the held lock was a TryRLock:\n%s", r)
	}
	h.tombstones.mu.RUnlock()

	// The purge's TryLock, and userLocks.tryLock, which try-locks a fresh
	// entry (rank 2) under its own leaf mutex (rank 9).
	h.seqMu.Lock()
	if r := rankPanic(t, func() {
		if h.tombstones.mu.TryLock() {
			h.tombstones.mu.Unlock()
		}
	}); r != "" {
		t.Fatalf("TryLock was flagged:\n%s", r)
	}
	h.seqMu.Unlock()
	var unlock func()
	if r := rankPanic(t, func() {
		var ok bool
		if unlock, ok = h.voiceMod.tryLock(1); !ok {
			t.Error("tryLock of an idle user failed")
		}
	}); r != "" {
		t.Fatalf("userLocks.tryLock was flagged:\n%s", r)
	}
	unlock()
}

func TestRank_CrossGoroutineUnlock(t *testing.T) {
	h := &Hub{}
	c := &Client{}

	// Locked here, unlocked on another goroutine: the hold leaves this
	// goroutine, so a later outer lock is not flagged against it.
	c.mu.Lock()
	done := make(chan struct{})
	go func() {
		defer close(done)
		c.mu.Unlock()
	}()
	<-done
	if r := rankPanic(t, func() { lockOnce(&h.mu) }); r != "" {
		t.Fatalf("a hold released on another goroutine was left behind:\n%s", r)
	}

	// Locked on another goroutine, unlocked here: the other goroutine's hold
	// goes, and this one, which never held it, is untouched.
	held := make(chan struct{})
	go func() {
		h.seqMu.Lock()
		close(held)
	}()
	<-held
	h.seqMu.Unlock()
	if r := rankPanic(t, func() { lockOnce(&h.seqMu) }); r != "" {
		t.Fatalf("a hold taken on another goroutine and released here was left behind:\n%s", r)
	}
	if n := syncutil.HoldsForTest(&h.seqMu) + syncutil.HoldsForTest(&c.mu) + syncutil.HoldsForTest(&h.mu); n != 0 {
		t.Fatalf("%d holds left in the table after every lock was released", n)
	}
}

// lockOnce takes l and releases it, and reports that it held it.
func lockOnce(l sync.Locker) bool {
	l.Lock()
	held := true
	l.Unlock()
	return held
}
