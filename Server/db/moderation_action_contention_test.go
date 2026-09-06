package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// TestBanUserWithAction_ConcurrentRoleChangeCannotPreemptAnInFlightDecision
// is P2-12 (Codex review): the service package's TestModeration_
// ConcurrentRoleChange drives both orderings by calling TimeoutUser twice in
// sequence — it never actually races two goroutines against each other, and
// with the database's writer pool at exactly one connection
// (SetMaxOpenConns(1)), a genuine mid-transaction interleaving that flips an
// already-computed decision is structurally impossible to construct: any
// concurrent second writer can only run strictly before this transaction's
// BeginTx or strictly after its Commit/Rollback, never during it — so a
// hook armed while the transaction is open can only ever prove the OTHER
// half of the same atomicity guarantee, which this test does with a REAL
// second goroutine instead of a doc comment's argument: a role change
// genuinely racing against BanUserWithAction, forced via a barrier inside
// the transaction (db.SetModerationActionPreInsertHookForTest, placed after
// the rank check and before the insert) to contend for that one connection,
// cannot preempt or invalidate the decision this transaction already
// computed from the rank it legitimately held when the check ran. The ban
// lands, its ledger row lands with it, and the raced role change is not
// lost — it simply applies once the connection is free, after this
// transaction ends.
func TestBanUserWithAction_ConcurrentRoleChangeCannotPreemptAnInFlightDecision(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	reached := make(chan struct{})
	release := make(chan struct{})
	db.SetModerationActionPreInsertHookForTest(func() {
		close(reached)
		<-release
	})
	defer db.SetModerationActionPreInsertHookForTest(nil)

	type banOutcome struct {
		id  int64
		err error
	}
	banDone := make(chan banOutcome, 1)
	go func() {
		id, err := database.BanUserWithAction(ctx, memberID, "concurrent", nil, ownerID, nil)
		banDone <- banOutcome{id: id, err: err}
	}()

	select {
	case <-reached:
	case <-time.After(5 * time.Second):
		t.Fatal("BanUserWithAction never reached the pre-insert hook — the contention barrier never armed")
	}

	// A genuinely concurrent writer, contending for the exact one writer
	// connection this open transaction still holds: promote memberID to
	// ownerID's own role. It cannot execute until the transaction above
	// commits or rolls back — there is no connection free for it to use, so
	// this attempt is forced to queue behind an in-flight decision it cannot
	// see or change.
	roleChangeErr := make(chan error, 1)
	go func() {
		_, err := database.ExecContext(ctx, `UPDATE users SET role_id = 1 WHERE id = ?`, memberID)
		roleChangeErr <- err
	}()

	// Best-effort: give the role-change goroutine a moment to actually queue
	// for the connection before releasing the hook. The correctness claim
	// below holds regardless of whether it got that far in time — SQLite's
	// single connection makes the ordering deterministic either way; this
	// only makes the race more likely to be genuinely in flight.
	time.Sleep(20 * time.Millisecond)
	close(release)

	outcome := <-banDone
	if err := <-roleChangeErr; err != nil {
		t.Fatalf("concurrent role change: %v", err)
	}
	if outcome.err != nil {
		t.Fatalf("BanUserWithAction: want success (the concurrent role change could not have landed before this "+
			"transaction's own rank check ran), got %v", outcome.err)
	}

	target, err := database.GetUserByID(ctx, memberID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if !target.Banned {
		t.Fatal("BanUserWithAction reported success but the target is not banned")
	}
	rows, err := database.ListModerationActionsForTarget(ctx, memberID)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	found := false
	for _, r := range rows {
		if r.ID == outcome.id && r.Kind == "ban" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no ban ledger row with id %d found in %+v — the effect landed without its ledger row", outcome.id, rows)
	}

	// The raced role change was not lost — it simply had to wait its turn.
	if target.RoleID != 1 {
		t.Fatalf("memberID.role_id = %d after the race settled, want 1 (the concurrent promotion applied once the "+
			"connection freed up)", target.RoleID)
	}
}
