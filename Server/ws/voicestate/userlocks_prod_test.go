//go:build !deadlock

package voicestate

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/ws/lockrank"
)

// TestUserLocks_ZeroValueAndTryLock holds a user's lock while it asks the same
// UserLocks again. The deadlock build's order detector reads TryLock's
// try-under-the-map-lock as an order and flags that, though a try cannot block;
// production never asks one instance again while holding one of its users.
func TestUserLocks_ZeroValueAndTryLock(t *testing.T) {
	var v UserLocks[lockrank.VoiceMember]
	unlock, ok := v.TryLock(1)
	if !ok {
		t.Fatal("TryLock of an idle user failed on a zero UserLocks")
	}
	if _, busy := v.TryLock(1); busy {
		t.Fatal("TryLock succeeded while the user's lock was held")
	}
	if n := v.Refs(1); n != 1 {
		t.Fatalf("Refs = %d while held, want 1", n)
	}
	unlock()
	if n := v.Refs(1); n != 0 {
		t.Fatalf("Refs = %d after release, want 0", n)
	}
	v.Lock(1)()
}
