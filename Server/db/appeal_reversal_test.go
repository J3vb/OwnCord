package db_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// TestDecideAppealTx_ReversalFailureAbortsTheWholeTransaction is F1's
// revert-proof test: a forced failure inside the overturn reversal must
// roll back the ENTIRE transaction, including the decision UPDATE itself —
// the appeal must be left "open" (never "overturned"), and the appealed
// timeout must remain active, exactly as if Decide had never been called.
// Before F1 the reversal ran AFTER the decision had already committed, so
// a failure here left the appellant told "overturned" while the timeout
// stayed in force; reintroducing that shape (decide first, best-effort
// reversal after, ignore its error) would make this test fail on the
// "appeal.State" assertion below.
func TestDecideAppealTx_ReversalFailureAbortsTheWholeTransaction(t *testing.T) {
	database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	expires := time.Now().Add(time.Hour)
	actionID, _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "cool off", expires)
	mustDo(t, "TimeoutUser", err)
	appealID := mustInsertAppeal(t, database, "pub-reversal-fail", actionID, memberID, "please")
	reversal := appealedActionOf(ctx, t, database, actionID)

	db.SetAppealReversalHookForTest(func() error { return errors.New("forced reversal failure for test") })
	defer db.SetAppealReversalHookForTest(nil)

	result, _, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "overturned", modID, "fine",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, nil)
	if err == nil {
		t.Fatal("DecideAppealTx with a forced reversal failure: want a non-nil error")
	}
	if result != db.AppealWriteReversalFailed {
		t.Fatalf("DecideAppealTx result = %v, want AppealWriteReversalFailed", result)
	}

	appeal := mustGetAppeal(t, database, appealID)
	if appeal.State != "open" {
		t.Fatalf("appeal state = %q, want open — the whole transaction (the decision UPDATE included) must have rolled back", appeal.State)
	}
	if appeal.DecidedBy != 0 {
		t.Fatalf("appeal decided_by = %d, want 0 — nothing committed", appeal.DecidedBy)
	}
	active, err := database.HasActiveTimeout(ctx, memberID)
	mustDo(t, "HasActiveTimeout", err)
	if !active {
		t.Fatal("timeout no longer active after a FAILED overturn — the reversal must not have run outside the aborted transaction")
	}
}
