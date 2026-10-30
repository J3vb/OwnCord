package ws

import (
	"context"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// The AFK move puts an idle member into the AFK channel without asking for its
// password: the client's re-join of the destination carries none.
func TestSweepAFK_MoveIntoProtectedAFKChannelNeedsNoPassword(t *testing.T) {
	r := newAFKRig(t, 1)
	alice := r.members[0]
	hash, err := bcrypt.GenerateFromPassword([]byte("secret"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.db.ExecContext(context.Background(),
		`UPDATE channels SET password_hash = ?, password_version = password_version + 1 WHERE id = ?`,
		string(hash), r.afk); err != nil {
		t.Fatal(err)
	}

	r.seat(alice, r.room)
	r.idle(alice, 10*time.Minute)
	r.sweep()
	if got := r.moved(alice); len(got) != 1 || got[0].to != r.afk {
		t.Fatalf("alice voice_moved = %+v, want one to ch%d", got, r.afk)
	}

	// The client answers voice_moved with a plain voice_join.
	if !r.join(alice, r.afk) {
		t.Fatal("the moved member's re-join of the protected AFK channel was refused")
	}
}

// An AFK candidate that is skipped (it came back before the evict) gets no
// grant for the AFK channel.
func TestSweepAFK_SkippedMoveStoresNoGrant(t *testing.T) {
	r := newAFKRig(t, 1)
	alice := r.members[0]
	hash, err := bcrypt.GenerateFromPassword([]byte("secret"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.db.ExecContext(context.Background(),
		`UPDATE channels SET password_hash = ?, password_version = password_version + 1 WHERE id = ?`,
		string(hash), r.afk); err != nil {
		t.Fatal(err)
	}
	r.seat(alice, r.room)
	// Not idle: the evict refuses it.
	if r.hub.EvictForAFKMove(context.Background(), alice.c, r.room, time.Now().Add(-10*time.Minute), r.afk) {
		t.Fatal("a member who is not idle was evicted")
	}
	if ok, err := r.db.HasChannelPasswordGrant(context.Background(), r.afk, alice.userID); err != nil || ok {
		t.Fatalf("skipped AFK move: grant=%v err=%v, want none", ok, err)
	}
}
