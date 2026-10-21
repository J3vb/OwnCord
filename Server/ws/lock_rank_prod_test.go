//go:build !deadlock

package ws

import (
	"sync"
	"testing"
)

// TestRank_ZeroValueUsable: the ranked locks need no constructor, so a bare
// &Hub{} or &Client{} literal (as many internal tests build) locks every one
// of them, and the per-user locks work from voiceRegistry's zero value.
func TestRank_ZeroValueUsable(t *testing.T) {
	h := &Hub{}
	c := &Client{}

	for _, l := range []sync.Locker{
		&h.mu, &h.seqMu, &h.settingsMu, &h.keyHolderMu, &h.presenceMu,
		&h.uploadPolicyMu, &h.timeoutView.mu, &h.tombstones.mu, &c.focusMu, &c.mu,
	} {
		lockOnce(l)
	}
	for _, l := range []rLocker{&h.mu, &h.settingsMu, &h.keyHolderMu, &h.tombstones.mu} {
		rlockOnce(l)
	}
	// Nested, outermost first, as a path takes them.
	c.focusMu.Lock()
	lockOnce(&c.mu)
	c.focusMu.Unlock()

	if !h.tombstones.mu.TryRLock() {
		t.Fatal("TryRLock of a zero-value RankedRW failed")
	}
	if h.tombstones.mu.TryLock() {
		t.Fatal("TryLock succeeded while a read lock was held")
	}
	h.tombstones.mu.RUnlock()
	if !h.tombstones.mu.TryLock() {
		t.Fatal("TryLock of an unlocked RankedRW failed")
	}
	h.tombstones.mu.Unlock()

	unlock := h.voiceReg.voiceMember.lock(7)
	if _, ok := h.voiceReg.voiceMember.tryLock(7); ok {
		t.Fatal("tryLock succeeded on a user whose lock is held")
	}
	unlock()
	unlockTry, ok := h.voiceReg.voiceMember.tryLock(7)
	if !ok {
		t.Fatal("tryLock of an idle user failed on a zero-value userLocks")
	}
	if !c.mu.TryLock() {
		t.Fatal("TryLock of a zero-value Ranked failed")
	}
	c.mu.Unlock()
	unlockTry()
	if n := h.voiceReg.voiceMember.refsForTest(7); n != 0 {
		t.Fatalf("refs = %d after every holder released, want 0", n)
	}
}

type rLocker interface {
	RLock()
	RUnlock()
}

// lockOnce takes l and releases it, and reports that it held it.
func lockOnce(l sync.Locker) bool {
	l.Lock()
	held := true
	l.Unlock()
	return held
}

// rlockOnce read-locks l and releases it, and reports that it held it.
func rlockOnce(l rLocker) bool {
	l.RLock()
	held := true
	l.RUnlock()
	return held
}
