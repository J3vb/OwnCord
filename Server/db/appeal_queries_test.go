package db_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// newAppealQueriesTestDB seeds a fully migrated database using the default
// seeded roles (migration 001/048): 1 = Owner (Administrator), 3 = Moderator
// (MODERATE_MEMBERS, granted by migration 048 to the untouched default row),
// 4 = Member (no special bit). Returns the database plus an owner, a
// moderator and two plain members.
func newAppealQueriesTestDB(t *testing.T) (database *db.DB, ownerID, modID, memberID, member2ID int64) {
	t.Helper()
	database = openMigratedMemory(t)
	var err error
	ownerID, err = database.CreateUser(context.Background(), "aq-owner", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser(owner): %v", err)
	}
	modID, err = database.CreateUser(context.Background(), "aq-mod", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser(mod): %v", err)
	}
	memberID, err = database.CreateUser(context.Background(), "aq-member", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(member): %v", err)
	}
	member2ID, err = database.CreateUser(context.Background(), "aq-member2", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(member2): %v", err)
	}
	return database, ownerID, modID, memberID, member2ID
}

// TestAppealQueries_InsertAppealRefusesAnUnknownAction is N4: InsertAppeal's
// INSERT ... WHERE EXISTS shape (mirroring reports' InsertReport) refuses an
// action id that does not exist — the same refusal Submit's TOCTOU review
// asks for when the action is erased between the service's ownership lookup
// and this write — mapped to db.ErrNotFound rather than a raw foreign-key
// error or a silently-inserted orphan row.
// TestAppealQueries_InsertAppealConcurrentBothInFlight is the
// test-strengthening ask for decision 8's "one appeal per action, ever":
// a barrier (appealInsertPreHookForTest, mirroring B5-9's
// moderationActionPreInsertHook contention-test shape) forces BOTH
// goroutines to actually reach InsertAppeal's own INSERT statement together
// before either proceeds — serial scheduling cannot make this pass by
// accident, only the UNIQUE(action_id) constraint the InsertAppeal doc
// comment names can. Exactly one of the two must succeed.
// TestAppealQueries_AssignAppealTx exercises the plain (non-forced) assign
// path's own transaction directly: a passing checkAuthority commits the
// assign, and a failing one refuses without writing anything (P2 review).
func TestAppealQueries_AssignAppealTx(t *testing.T) {
	database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-assigntx", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}

	ok, err := database.AssignAppealTx(ctx, appealID, modID, 0, modID, simpleAuthorityCheck)
	if err != nil {
		t.Fatalf("AssignAppealTx: %v", err)
	}
	if !ok {
		t.Fatal("AssignAppealTx reported no row affected")
	}
	got, err := database.GetAppeal(ctx, appealID)
	if err != nil {
		t.Fatalf("GetAppeal: %v", err)
	}
	if got.State != "assigned" || got.AssigneeID != modID {
		t.Fatalf("appeal after AssignAppealTx = %+v, want assigned/%d", got, modID)
	}

	// A failing checkAuthority refuses, and nothing changes.
	appealID2, err := database.InsertAppeal(ctx, "pub-assigntx-2", func() int64 {
		id, err := database.WarnUser(ctx, memberID, ownerID, nil, "y")
		if err != nil {
			t.Fatalf("WarnUser (2nd): %v", err)
		}
		return id
	}(), memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal (2nd): %v", err)
	}
	alwaysFails := func(int64, bool, *string) error { return errors.New("no authority") }
	if _, err := database.AssignAppealTx(ctx, appealID2, modID, 0, modID, alwaysFails); !errors.Is(err, db.ErrForbidden) {
		t.Fatalf("AssignAppealTx with a failing authority check: want db.ErrForbidden, got %v", err)
	}
	unchanged, err := database.GetAppeal(ctx, appealID2)
	if err != nil {
		t.Fatalf("GetAppeal (2nd): %v", err)
	}
	if unchanged.State != "open" || unchanged.AssigneeID != 0 {
		t.Fatalf("appeal after the refused AssignAppealTx = %+v, want unchanged (open/0)", unchanged)
	}
}

// TestReversalAuditActionFor pins the exported name mapping item 4's
// reversal audit rows use, so a rename or a dropped kind is caught here
// directly rather than only through the service-layer test that calls it.
func TestReversalAuditActionFor(t *testing.T) {
	cases := []struct {
		kind       string
		wantAction string
		wantOK     bool
	}{
		{"timeout", "user_untimeout", true},
		{"ban", "user_unban", true},
		{"warning", "user_warning_acknowledged", true},
		{"removal", "", false},
	}
	for _, c := range cases {
		action, ok := db.ReversalAuditActionFor(c.kind)
		if action != c.wantAction || ok != c.wantOK {
			t.Errorf("ReversalAuditActionFor(%q) = (%q, %v), want (%q, %v)", c.kind, action, ok, c.wantAction, c.wantOK)
		}
	}
}

func TestAppealQueries_InsertAppealConcurrentBothInFlight(t *testing.T) {
	database, ownerID, _, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}

	var wg sync.WaitGroup
	wg.Add(2)
	db.SetAppealInsertPreHookForTest(func() {
		wg.Done()
		wg.Wait() // block until BOTH callers have reached the insert
	})
	defer db.SetAppealInsertPreHookForTest(nil)

	type outcome struct {
		id  int64
		err error
	}
	results := make([]outcome, 2)
	var runners sync.WaitGroup
	runners.Add(2)
	for i, publicID := range []string{"pub-concurrent-a", "pub-concurrent-b"} {
		go func(i int, publicID string) {
			defer runners.Done()
			id, err := database.InsertAppeal(ctx, publicID, actionID, memberID, "please")
			results[i] = outcome{id: id, err: err}
		}(i, publicID)
	}
	runners.Wait()

	successes := 0
	for _, r := range results {
		if r.err == nil {
			successes++
			if r.id == 0 {
				t.Error("a successful concurrent insert returned id 0")
			}
		} else if !errors.Is(r.err, db.ErrConflict) {
			t.Errorf("concurrent InsertAppeal: unexpected error %v", r.err)
		}
	}
	if successes != 1 {
		t.Fatalf("concurrent inserts succeeded = %d, want exactly 1", successes)
	}
}

func TestAppealQueries_InsertAppealRefusesAnUnknownAction(t *testing.T) {
	database, _, _, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	if _, err := database.InsertAppeal(ctx, "pub-unknown-action", 999999, memberID, "please"); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("InsertAppeal against an unknown action: want db.ErrNotFound, got %v", err)
	}
	if id, err := database.FindAppealForAction(ctx, 999999); err != nil || id != 0 {
		t.Fatalf("FindAppealForAction after the refused insert = (%d, %v), want (0, nil) — nothing landed", id, err)
	}
}

func TestAppealQueries_InsertFindGetLifecycle(t *testing.T) {
	database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "be nice")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}

	if id, err := database.FindAppealForAction(ctx, actionID); err != nil || id != 0 {
		t.Fatalf("FindAppealForAction before any appeal = (%d, %v), want (0, nil)", id, err)
	}

	appealID, err := database.InsertAppeal(ctx, "pub-aq-1", actionID, memberID, "please reconsider")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}

	if id, err := database.FindAppealForAction(ctx, actionID); err != nil || id != appealID {
		t.Fatalf("FindAppealForAction after insert = (%d, %v), want (%d, nil)", id, err, appealID)
	}

	// The UNIQUE(action_id) constraint refuses a second appeal against the
	// same action, mapped to db.ErrConflict.
	if _, err := database.InsertAppeal(ctx, "pub-aq-2", actionID, memberID, "again"); !errors.Is(err, db.ErrConflict) {
		t.Fatalf("second InsertAppeal for the same action: want db.ErrConflict, got %v", err)
	}

	got, err := database.GetAppeal(ctx, appealID)
	if err != nil {
		t.Fatalf("GetAppeal: %v", err)
	}
	if got.ActionID != actionID || got.AppellantID != memberID || got.Body != "please reconsider" || got.State != "open" {
		t.Fatalf("GetAppeal = %+v, want action %d, appellant %d, body %q, state open", got, actionID, memberID, "please reconsider")
	}

	byPublic, err := database.GetAppealByPublicID(ctx, "pub-aq-1")
	if err != nil {
		t.Fatalf("GetAppealByPublicID: %v", err)
	}
	if byPublic.ID != appealID {
		t.Fatalf("GetAppealByPublicID.ID = %d, want %d", byPublic.ID, appealID)
	}
	if _, err := database.GetAppealByPublicID(ctx, "no-such-public-id"); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("GetAppealByPublicID unknown id: want db.ErrNotFound, got %v", err)
	}
	if _, err := database.GetAppeal(ctx, 999999); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("GetAppeal unknown id: want db.ErrNotFound, got %v", err)
	}

	mine, err := database.ListAppealsMine(ctx, memberID)
	if err != nil {
		t.Fatalf("ListAppealsMine: %v", err)
	}
	if len(mine) != 1 || mine[0].PublicID != "pub-aq-1" {
		t.Fatalf("ListAppealsMine = %+v, want one row for pub-aq-1", mine)
	}
	if mine2, err := database.ListAppealsMine(ctx, ownerID); err != nil || len(mine2) != 0 {
		t.Fatalf("ListAppealsMine(owner) = (%+v, %v), want (empty, nil)", mine2, err)
	}

	for _, state := range []string{"", "open"} {
		rows, err := database.ListAppealsQueue(ctx, state)
		if err != nil {
			t.Fatalf("ListAppealsQueue(%q): %v", state, err)
		}
		if len(rows) != 1 || rows[0].ID != appealID {
			t.Fatalf("ListAppealsQueue(%q) = %+v, want one row for appeal %d", state, rows, appealID)
		}
	}
	if rows, err := database.ListAppealsQueue(ctx, "assigned"); err != nil || len(rows) != 0 {
		t.Fatalf("ListAppealsQueue(assigned) before assignment = (%+v, %v), want (empty, nil)", rows, err)
	}
	if rows, err := database.ListAppealsQueue(ctx, "decided"); err != nil || len(rows) != 0 {
		t.Fatalf("ListAppealsQueue(decided) before decision = (%+v, %v), want (empty, nil)", rows, err)
	}

	// ── Assign ──
	ok, err := database.AssignAppeal(ctx, appealID, modID, 0)
	if err != nil {
		t.Fatalf("AssignAppeal: %v", err)
	}
	if !ok {
		t.Fatal("AssignAppeal reported no row affected")
	}
	if rows, err := database.ListAppealsQueue(ctx, "assigned"); err != nil || len(rows) != 1 || rows[0].AssigneeID != modID {
		t.Fatalf("ListAppealsQueue(assigned) after assignment = (%+v, %v), want one row assigned to %d", rows, err, modID)
	}
	// A stale observed-assignee value is refused (optimistic concurrency).
	if ok, err := database.AssignAppeal(ctx, appealID, ownerID, 0); err != nil || ok {
		t.Fatalf("AssignAppeal with a stale observed assignee = (%v, %v), want (false, nil)", ok, err)
	}

	// ── Decide ──
	// The observed state is now "assigned" (the owner assigned it above),
	// with the owner as the observed assignee (Claim 5 review).
	action, err := database.GetModerationAction(ctx, actionID)
	if err != nil {
		t.Fatalf("GetModerationAction: %v", err)
	}
	reversal := db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}
	result, soleModerator, _, err := database.DecideAppealTx(ctx, appealID, "assigned", modID, "upheld", ownerID, "no",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, nil)
	if err != nil {
		t.Fatalf("DecideAppealTx: %v", err)
	}
	if result != db.AppealWriteOK {
		t.Fatalf("DecideAppealTx result = %v, want AppealWriteOK", result)
	}
	if soleModerator {
		t.Fatal("soleModerator = true, want false (the owner did not take the appealed action)")
	}
	decided, err := database.GetAppeal(ctx, appealID)
	if err != nil {
		t.Fatalf("GetAppeal after decision: %v", err)
	}
	if decided.State != "upheld" || decided.DecidedBy != ownerID || decided.DecisionNote != "no" || decided.DecidedAt == nil {
		t.Fatalf("appeal after decision = %+v, want state upheld, decided_by %d, note %q, decided_at set", decided, ownerID, "no")
	}
	if rows, err := database.ListAppealsQueue(ctx, "decided"); err != nil || len(rows) != 1 || rows[0].ID != appealID {
		t.Fatalf("ListAppealsQueue(decided) after decision = (%+v, %v), want one row for appeal %d", rows, err, appealID)
	}
	// Nothing leaves a decided state.
	result, _, _, err = database.DecideAppealTx(ctx, appealID, "upheld", modID, "overturned", ownerID, "again",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, nil)
	if err != nil {
		t.Fatalf("re-deciding: %v", err)
	}
	if result != db.AppealWriteConflict {
		t.Fatalf("re-deciding a decided appeal: result = %v, want AppealWriteConflict", result)
	}
	if ok, err := database.WithdrawAppeal(ctx, appealID, memberID); err != nil || ok {
		t.Fatalf("withdrawing a decided appeal = (%v, %v), want (false, nil)", ok, err)
	}
}

// TestAppealQueries_DecideAppealTxAppliesEachReversalKind exercises
// applyAppealReversalTx's four kind branches DIRECTLY at the db layer (not
// merely through a service-layer test): the package's own coverage
// instrumentation only counts a call as covered when db's OWN tests reach
// it, so a reversal kind exercised only via service tests (which call
// through db as a dependency) shows as uncovered here despite being
// thoroughly tested one layer up.
// simpleAuthorityCheck is a minimal stand-in for service.AppealService's
// real checkModeratorAuthority, used by db-layer tests that only need to
// prove DecideAppealTx/AssignAppealTx re-read fresh state inside their own
// transaction — not exercise the service's own closure.
func simpleAuthorityCheck(rolePerms int64, banned bool, banExpires *string) error {
	if banned && banExpires == nil {
		return errors.New("banned")
	}
	return permissions.CanModerate(permissions.Subject{RolePerms: rolePerms})
}

// TestDecideAppealTx_BitRevokedBeforeTxRefuses is item 2 (P2 review): the
// decider's own authority is re-read fresh INSIDE the transaction, never
// trusted from before it began. The pre-BeginTx hook demotes modID (revokes
// MODERATE_MEMBERS) in the exact gap between the caller's earlier
// authorization and DecideAppealTx's own BeginTx — proving the transaction
// boundary, not mere sequencing, is what the guard depends on.
func TestDecideAppealTx_BitRevokedBeforeTxRefuses(t *testing.T) {
	database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-bit-revoked", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}

	db.SetAppealDecidePreBeginTxHookForTest(func() {
		if err := database.UpdateUserRole(ctx, modID, 4); err != nil { // demote to plain Member
			t.Fatalf("UpdateUserRole: %v", err)
		}
	})
	defer db.SetAppealDecidePreBeginTxHookForTest(nil)

	action, err := database.GetModerationAction(ctx, actionID)
	if err != nil {
		t.Fatalf("GetModerationAction: %v", err)
	}
	reversal := db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}
	result, _, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "upheld", modID, "no",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, simpleAuthorityCheck)
	if err != nil {
		t.Fatalf("DecideAppealTx: %v", err)
	}
	if result != db.AppealWriteForbidden {
		t.Fatalf("DecideAppealTx after the decider's bit was revoked pre-tx: result = %v, want AppealWriteForbidden", result)
	}
	got, err := database.GetAppeal(ctx, appealID)
	if err != nil {
		t.Fatalf("GetAppeal: %v", err)
	}
	if got.State != "open" || got.DecidedBy != 0 {
		t.Fatalf("appeal after the refused decide = %+v, want unchanged (open, decided_by 0)", got)
	}
}

// TestDecideAppealTx_BanLandedBeforeTxRefuses is item 2's ban twin: a
// permanent ban landing on the decider in the same pre-BeginTx gap must
// refuse identically.
func TestDecideAppealTx_BanLandedBeforeTxRefuses(t *testing.T) {
	database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-ban-landed", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}

	db.SetAppealDecidePreBeginTxHookForTest(func() {
		if err := database.BanUser(ctx, modID, "spam", nil); err != nil { // permanent ban
			t.Fatalf("BanUser: %v", err)
		}
	})
	defer db.SetAppealDecidePreBeginTxHookForTest(nil)

	action, err := database.GetModerationAction(ctx, actionID)
	if err != nil {
		t.Fatalf("GetModerationAction: %v", err)
	}
	reversal := db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}
	result, _, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "upheld", modID, "no",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, simpleAuthorityCheck)
	if err != nil {
		t.Fatalf("DecideAppealTx: %v", err)
	}
	if result != db.AppealWriteForbidden {
		t.Fatalf("DecideAppealTx after the decider was banned pre-tx: result = %v, want AppealWriteForbidden", result)
	}
}

// TestAssignAppealForced_BitRevokedBeforeTxRefuses is item 2's forced
// re-assign twin, via forceReassignPreBeginTxHook: proves the transaction
// placement of the checkAuthority re-check (not just that it exists), by
// moving the ACTOR to a role that still outranks the current assignee but
// no longer holds MODERATE_MEMBERS/Administrator, in the exact pre-BeginTx
// gap — isolating the NEW authority check from the pre-existing outrank
// check (a demotion to a role that ALSO drops rank would pass for the wrong
// reason, proving nothing about this specific guard).
func TestAssignAppealForced_BitRevokedBeforeTxRefuses(t *testing.T) {
	database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	// A role that outranks the Member role (position 40) but holds no bit.
	unprivilegedButHighRank, err := database.CreateRole(ctx, "unprivileged-high-rank", nil, 0, 70)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-forced-bit-revoked", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}
	if ok, err := database.AssignAppeal(ctx, appealID, memberID, 0); err != nil || !ok {
		t.Fatalf("AssignAppeal: (%v, %v)", ok, err)
	}

	db.SetForceReassignPreBeginTxHookForTest(func() {
		if err := database.UpdateUserRole(ctx, modID, unprivilegedButHighRank.ID); err != nil {
			t.Fatalf("UpdateUserRole: %v", err)
		}
	})
	defer db.SetForceReassignPreBeginTxHookForTest(nil)

	if _, err := database.AssignAppealForced(ctx, appealID, modID, memberID, modID, simpleAuthorityCheck); !errors.Is(err, db.ErrForbidden) {
		t.Fatalf("AssignAppealForced after the actor's bit was revoked pre-tx (rank alone would still outrank): want db.ErrForbidden, got %v", err)
	}
}

// TestDecideAppealTx_EligibilityCountIsFreshInsideTheTransaction is F2's
// test-strengthening ask: the self-review eligibility test must be
// evaluated INSIDE the transaction, not cached from before it began. A sole
// eligible moderator (modID) takes the appealed action; a second eligible
// moderator is promoted in the exact pre-BeginTx gap (the same barrier item
// 2 uses). If the count ran before BeginTx (moving it out), it would have
// seen "sole moderator" and let the self-review escape wrongly apply; the
// fresh in-tx count sees the newly-promoted second moderator and correctly
// refuses with AppealWriteSelfReview instead.
func TestDecideAppealTx_EligibilityCountIsFreshInsideTheTransaction(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	modID, err := database.CreateUser(ctx, "f2-sole-mod", "hash", 3) // Moderator: MODERATE_MEMBERS
	if err != nil {
		t.Fatalf("CreateUser(mod): %v", err)
	}
	memberID, err := database.CreateUser(ctx, "f2-member", "hash", 4) // Member: no bit
	if err != nil {
		t.Fatalf("CreateUser(member): %v", err)
	}
	secondModID, err := database.CreateUser(ctx, "f2-second-mod", "hash", 4) // starts as a plain Member
	if err != nil {
		t.Fatalf("CreateUser(second mod, starts unprivileged): %v", err)
	}

	actionID, err := database.WarnUser(ctx, memberID, modID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-f2-fresh", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}

	db.SetAppealDecidePreBeginTxHookForTest(func() {
		// Promote the second user to Moderator in the exact gap between the
		// caller's earlier (sole-moderator) view and this transaction's own
		// fresh count.
		if err := database.UpdateUserRole(ctx, secondModID, 3); err != nil {
			t.Fatalf("UpdateUserRole: %v", err)
		}
	})
	defer db.SetAppealDecidePreBeginTxHookForTest(nil)

	action, err := database.GetModerationAction(ctx, actionID)
	if err != nil {
		t.Fatalf("GetModerationAction: %v", err)
	}
	reversal := db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}
	result, soleModerator, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "upheld", modID, "self-serving",
		true, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, nil)
	if err != nil {
		t.Fatalf("DecideAppealTx: %v", err)
	}
	if result != db.AppealWriteSelfReview {
		t.Fatalf("DecideAppealTx with a moderator promoted pre-tx: result = %v, want AppealWriteSelfReview (the fresh count must see the new moderator)", result)
	}
	if soleModerator {
		t.Fatal("soleModerator = true, want false — a second eligible moderator exists per the fresh count")
	}
}

func TestAppealQueries_DecideAppealTxAppliesEachReversalKind(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		ctx := context.Background()
		database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
		actionID, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "cool off", time.Now().Add(time.Hour))
		if err != nil {
			t.Fatalf("TimeoutUser: %v", err)
		}
		appealID, err := database.InsertAppeal(ctx, "pub-reversal-timeout", actionID, memberID, "please")
		if err != nil {
			t.Fatalf("InsertAppeal: %v", err)
		}
		action, err := database.GetModerationAction(ctx, actionID)
		if err != nil {
			t.Fatalf("GetModerationAction: %v", err)
		}
		reversal := db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}
		result, _, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "overturned", modID, "fine",
			false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, nil)
		if err != nil || result != db.AppealWriteOK {
			t.Fatalf("DecideAppealTx: (%v, %v), want (AppealWriteOK, nil)", result, err)
		}
		active, err := database.HasActiveTimeout(ctx, memberID)
		if err != nil {
			t.Fatalf("HasActiveTimeout: %v", err)
		}
		if active {
			t.Fatal("timeout still active after overturning it")
		}
	})

	t.Run("ban", func(t *testing.T) {
		ctx := context.Background()
		database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
		actionID, err := database.BanUserWithAction(ctx, memberID, "spam", nil, ownerID, nil)
		if err != nil {
			t.Fatalf("BanUserWithAction: %v", err)
		}
		appealID, err := database.InsertAppeal(ctx, "pub-reversal-ban", actionID, memberID, "please")
		if err != nil {
			t.Fatalf("InsertAppeal: %v", err)
		}
		action, err := database.GetModerationAction(ctx, actionID)
		if err != nil {
			t.Fatalf("GetModerationAction: %v", err)
		}
		reversal := db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}
		result, _, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "overturned", modID, "fine",
			false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, nil)
		if err != nil || result != db.AppealWriteOK {
			t.Fatalf("DecideAppealTx: (%v, %v), want (AppealWriteOK, nil)", result, err)
		}
		target, err := database.GetUserByID(ctx, memberID)
		if err != nil {
			t.Fatalf("GetUserByID: %v", err)
		}
		if target.Banned {
			t.Fatal("target still banned after overturning the ban")
		}
	})

	t.Run("warning", func(t *testing.T) {
		ctx := context.Background()
		database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
		actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "be nice")
		if err != nil {
			t.Fatalf("WarnUser: %v", err)
		}
		appealID, err := database.InsertAppeal(ctx, "pub-reversal-warning", actionID, memberID, "please")
		if err != nil {
			t.Fatalf("InsertAppeal: %v", err)
		}
		action, err := database.GetModerationAction(ctx, actionID)
		if err != nil {
			t.Fatalf("GetModerationAction: %v", err)
		}
		reversal := db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}
		result, _, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "overturned", modID, "fine",
			false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, nil)
		if err != nil || result != db.AppealWriteOK {
			t.Fatalf("DecideAppealTx: (%v, %v), want (AppealWriteOK, nil)", result, err)
		}
		notices, err := database.ListUnacknowledgedWarnings(ctx, memberID)
		if err != nil {
			t.Fatalf("ListUnacknowledgedWarnings: %v", err)
		}
		if len(notices) != 0 {
			t.Fatalf("unacknowledged notices after overturning a warning = %d, want 0", len(notices))
		}
	})

	t.Run("removal", func(t *testing.T) {
		ctx := context.Background()
		database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
		chID, err := database.CreateChannel(ctx, "reversal-removal", "text", "", "", 0)
		if err != nil {
			t.Fatalf("CreateChannel: %v", err)
		}
		msgID, err := database.CreateMessage(ctx, chID, memberID, "reported content", nil)
		if err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		if err := database.DeleteMessageWithRemoval(ctx, msgID, ownerID, true, memberID, nil, "violated rule 3"); err != nil {
			t.Fatalf("DeleteMessageWithRemoval: %v", err)
		}
		rows, err := database.ListModerationActionsForTarget(ctx, memberID)
		if err != nil {
			t.Fatalf("ListModerationActionsForTarget: %v", err)
		}
		var actionID int64
		for i := range rows {
			if r := &rows[i]; r.Kind == "removal" {
				actionID = r.ID
			}
		}
		if actionID == 0 {
			t.Fatal("no removal ledger row found")
		}
		appealID, err := database.InsertAppeal(ctx, "pub-reversal-removal", actionID, memberID, "please")
		if err != nil {
			t.Fatalf("InsertAppeal: %v", err)
		}
		action, err := database.GetModerationAction(ctx, actionID)
		if err != nil {
			t.Fatalf("GetModerationAction: %v", err)
		}
		reversal := db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}
		result, _, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "overturned", modID, "fine",
			false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, nil)
		if err != nil || result != db.AppealWriteOK {
			t.Fatalf("DecideAppealTx: (%v, %v), want (AppealWriteOK, nil) — removal is record-only, never an error", result, err)
		}
	})
}

// TestAppealQueries_DecideRefusesAssignThatLandedAfterTheCallersRead is
// Claim 5's race: a caller reads the appeal as "open"/unassigned, then a
// REAL Assign lands from someone else before the caller's own Decide write
// reaches the database. A guard that only checked "state IN (open,
// assigned)" would let the caller's decision land anyway, silently
// discarding the assignment; DecideAppeal is guarded on the caller's
// OBSERVED state and assignee, so this decide must be refused (zero rows
// affected) and the real assignment must survive untouched.
func TestAppealQueries_DecideRefusesAssignThatLandedAfterTheCallersRead(t *testing.T) {
	database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "be nice")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-aq-race", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}

	// modID "reads" the appeal here: open, unassigned.
	observed, err := database.GetAppeal(ctx, appealID)
	if err != nil {
		t.Fatalf("GetAppeal (the caller's read): %v", err)
	}
	if observed.State != "open" || observed.AssigneeID != 0 {
		t.Fatalf("observed appeal = %+v, want open/unassigned", observed)
	}

	// The owner's REAL assign lands before modID's decide reaches the DB.
	if ok, err := database.AssignAppeal(ctx, appealID, ownerID, 0); err != nil || !ok {
		t.Fatalf("AssignAppeal(owner): (%v, %v), want (true, nil)", ok, err)
	}

	action, err := database.GetModerationAction(ctx, actionID)
	if err != nil {
		t.Fatalf("GetModerationAction: %v", err)
	}
	reversal := db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}
	// modID now decides using its STALE read (observed.State, observed.AssigneeID).
	result, _, _, err := database.DecideAppealTx(ctx, appealID, observed.State, observed.AssigneeID, "upheld", modID, "stale",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, nil)
	if err != nil {
		t.Fatalf("DecideAppealTx with a stale observed read: %v", err)
	}
	if result != db.AppealWriteConflict {
		t.Fatalf("DecideAppealTx with a stale observed read: result = %v, want AppealWriteConflict", result)
	}

	after, err := database.GetAppeal(ctx, appealID)
	if err != nil {
		t.Fatalf("GetAppeal after the refused decide: %v", err)
	}
	if after.State != "assigned" || after.AssigneeID != ownerID {
		t.Fatalf("appeal after the refused decide = %+v, want the real assignment (assigned/%d) untouched", after, ownerID)
	}
	if after.DecidedBy != 0 {
		t.Fatalf("decided_by after the refused decide = %d, want 0", after.DecidedBy)
	}
}

// TestAppealQueries_DecideGuardCatchesStateChangeAloneWithAssigneeUnchanged
// covers a real decide landing (state moves to a terminal value) while
// assignee_id stays put, and proves a second, stale decide is refused
// there too. Revert-proof note (Claim 5 review): unlike its
// assignee-predicate sibling below, disabling ONLY the observed_state
// equality check does NOT turn this test red, because
// appeals.state IN ('open','assigned') already refuses any write once the
// row is terminal — every reachable transition that changes state either
// also changes assignee_id (open -> assigned, via Assign) or leaves the
// open/assigned set entirely (Decide), so observed_state's equality check
// is defense-in-depth for this scenario, not the sole guard. Kept for
// explicitness, and in case the blanket IN clause is ever loosened without
// this line being revisited.
func TestAppealQueries_DecideGuardCatchesStateChangeAloneWithAssigneeUnchanged(t *testing.T) {
	database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-state-alone", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}
	if ok, err := database.AssignAppeal(ctx, appealID, modID, 0); err != nil || !ok {
		t.Fatalf("AssignAppeal: (%v, %v)", ok, err)
	}
	// The caller "reads" here: assigned to modID.
	observed, err := database.GetAppeal(ctx, appealID)
	if err != nil {
		t.Fatalf("GetAppeal (the caller's read): %v", err)
	}

	action, err := database.GetModerationAction(ctx, actionID)
	if err != nil {
		t.Fatalf("GetModerationAction: %v", err)
	}
	reversal := db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}

	// A REAL decide lands first: state changes, assignee_id does NOT.
	if result, _, _, err := database.DecideAppealTx(ctx, appealID, observed.State, observed.AssigneeID, "upheld", modID, "real",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, nil); err != nil || result != db.AppealWriteOK {
		t.Fatalf("real DecideAppealTx: (%v, %v), want (AppealWriteOK, nil)", result, err)
	}
	after, err := database.GetAppeal(ctx, appealID)
	if err != nil {
		t.Fatalf("GetAppeal after the real decide: %v", err)
	}
	if after.AssigneeID != observed.AssigneeID {
		t.Fatalf("assignee_id changed by Decide (=%d, was %d) — this test needs it to stay put to isolate the state predicate", after.AssigneeID, observed.AssigneeID)
	}

	// The stale decide observed the OLD state ("assigned") but the CURRENT
	// (unchanged) assignee — only the state predicate can catch this.
	result, _, _, err := database.DecideAppealTx(ctx, appealID, observed.State, observed.AssigneeID, "overturned", modID, "stale",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, nil)
	if err != nil {
		t.Fatalf("stale DecideAppealTx: %v", err)
	}
	if result != db.AppealWriteConflict {
		t.Fatalf("stale DecideAppealTx (state changed, assignee unchanged): result = %v, want AppealWriteConflict", result)
	}
}

// TestAppealQueries_DecideGuardCatchesAssigneeChangeAloneWithStateUnchanged
// is Claim 5's other isolation test: the observed_assignee_id predicate
// must catch staleness even when observed_state happens to still match (so
// a guard that dropped the assignee predicate and kept only the state one
// would wrongly let this land). A force-reassign changes assignee_id
// without changing state (still "assigned"), so a second, stale decide
// that observed the PRE-reassign assignee (but the still-correct state)
// must still be refused.
func TestAppealQueries_DecideGuardCatchesAssigneeChangeAloneWithStateUnchanged(t *testing.T) {
	database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-assignee-alone", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}
	if ok, err := database.AssignAppeal(ctx, appealID, modID, 0); err != nil || !ok {
		t.Fatalf("AssignAppeal: (%v, %v)", ok, err)
	}
	// The caller "reads" here: assigned to modID.
	observed, err := database.GetAppeal(ctx, appealID)
	if err != nil {
		t.Fatalf("GetAppeal (the caller's read): %v", err)
	}

	// A REAL force-reassign lands: assignee_id changes, state does NOT
	// (AssignAppeal's own UPDATE sets state = 'assigned' unconditionally).
	if ok, err := database.AssignAppealForced(ctx, appealID, ownerID, modID, ownerID, nil); err != nil || !ok {
		t.Fatalf("AssignAppealForced: (%v, %v)", ok, err)
	}
	after, err := database.GetAppeal(ctx, appealID)
	if err != nil {
		t.Fatalf("GetAppeal after the real reassign: %v", err)
	}
	if after.State != observed.State {
		t.Fatalf("state changed by the reassign (=%q, was %q) — this test needs it to stay put to isolate the assignee predicate", after.State, observed.State)
	}
	if after.AssigneeID == observed.AssigneeID {
		t.Fatal("assignee_id did not actually change — the reassign did not do its job")
	}

	action, err := database.GetModerationAction(ctx, actionID)
	if err != nil {
		t.Fatalf("GetModerationAction: %v", err)
	}
	reversal := db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}

	// The stale decide observed the OLD assignee (modID) but the CURRENT
	// (unchanged) state ("assigned") — only the assignee predicate can
	// catch this.
	result, _, _, err := database.DecideAppealTx(ctx, appealID, observed.State, observed.AssigneeID, "upheld", modID, "stale",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, nil)
	if err != nil {
		t.Fatalf("stale DecideAppealTx: %v", err)
	}
	if result != db.AppealWriteConflict {
		t.Fatalf("stale DecideAppealTx (assignee changed, state unchanged): result = %v, want AppealWriteConflict", result)
	}
}

// TestAppealQueries_AssignAppealRefusesAnErasedAssignee is AssignAppeal's
// EXISTS(users) guard: a moderator erased between the caller's requireModerate
// check and this write cannot land as the appeal's new assignee — the write
// affects zero rows rather than assigning a dangling id.
func TestAppealQueries_AssignAppealRefusesAnErasedAssignee(t *testing.T) {
	database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-assignee-erased", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}
	if _, err := database.EraseAccount(ctx, modID, ""); err != nil {
		t.Fatalf("EraseAccount(modID): %v", err)
	}

	ok, err := database.AssignAppeal(ctx, appealID, modID, 0)
	if err != nil {
		t.Fatalf("AssignAppeal with an erased assignee: %v", err)
	}
	if ok {
		t.Fatal("AssignAppeal reported success naming an erased user as the new assignee")
	}
	got, err := database.GetAppeal(ctx, appealID)
	if err != nil {
		t.Fatalf("GetAppeal: %v", err)
	}
	if got.State != "open" || got.AssigneeID != 0 {
		t.Fatalf("appeal after the refused assign = %+v, want unchanged (open/0)", got)
	}
}

// TestAppealQueries_DecideAppealTxRefusesAnErasedDecider is DecideAppeal's
// EXISTS(users) guard, the mirror of AssignAppeal's above: a moderator erased
// between requireModerate and this write cannot land as decided_by either —
// the whole transaction (DecideAppealTx) reports AppealWriteConflict, not a
// decision recorded against a dangling id.
func TestAppealQueries_DecideAppealTxRefusesAnErasedDecider(t *testing.T) {
	database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-decider-erased", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}
	if _, err := database.EraseAccount(ctx, modID, ""); err != nil {
		t.Fatalf("EraseAccount(modID): %v", err)
	}

	action, err := database.GetModerationAction(ctx, actionID)
	if err != nil {
		t.Fatalf("GetModerationAction: %v", err)
	}
	reversal := db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}
	result, _, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "upheld", modID, "no",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, nil)
	if err != nil {
		t.Fatalf("DecideAppealTx with an erased decider: %v", err)
	}
	if result != db.AppealWriteConflict {
		t.Fatalf("DecideAppealTx with an erased decider: result = %v, want AppealWriteConflict", result)
	}
	got, err := database.GetAppeal(ctx, appealID)
	if err != nil {
		t.Fatalf("GetAppeal: %v", err)
	}
	if got.State != "open" || got.DecidedBy != 0 {
		t.Fatalf("appeal after the refused decide = %+v, want unchanged (open, decided_by 0)", got)
	}
}

func TestAppealQueries_AssignAppealForced(t *testing.T) {
	database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-forced-1", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}
	if ok, err := database.AssignAppeal(ctx, appealID, modID, 0); err != nil || !ok {
		t.Fatalf("AssignAppeal: (%v, %v)", ok, err)
	}

	// The owner (position 100) outranks the moderator (position 60) and may
	// force-reassign. Both principals' positions are now read fresh inside
	// the write's own transaction (inherited-P2 review), so the caller
	// passes actorID, not a pre-read position.
	ok, err := database.AssignAppealForced(ctx, appealID, ownerID, modID, ownerID, nil)
	if err != nil {
		t.Fatalf("AssignAppealForced: %v", err)
	}
	if !ok {
		t.Fatal("AssignAppealForced reported no row affected")
	}
	got, err := database.GetAppeal(ctx, appealID)
	if err != nil {
		t.Fatalf("GetAppeal: %v", err)
	}
	if got.AssigneeID != ownerID {
		t.Fatalf("assignee after forced reassign = %d, want %d", got.AssigneeID, ownerID)
	}

	// A second forced reassignment attempt, this time by someone who does
	// NOT outrank the current assignee (the owner), is refused.
	appealID2, err := database.InsertAppeal(ctx, "pub-forced-2", func() int64 {
		id, err := database.WarnUser(ctx, memberID, ownerID, nil, "y")
		if err != nil {
			t.Fatalf("WarnUser (2nd): %v", err)
		}
		return id
	}(), memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal (2nd): %v", err)
	}
	if ok, err := database.AssignAppeal(ctx, appealID2, ownerID, 0); err != nil || !ok {
		t.Fatalf("AssignAppeal (2nd): (%v, %v)", ok, err)
	}
	if _, err := database.AssignAppealForced(ctx, appealID2, modID, ownerID, modID, nil); !errors.Is(err, db.ErrForbidden) {
		t.Fatalf("AssignAppealForced without outranking: want db.ErrForbidden, got %v", err)
	}

	// A forced reassignment naming an assignee who no longer resolves to any
	// role (erased) reports (false, nil) rather than an error.
	if ok, err := database.AssignAppealForced(ctx, appealID2, modID, 999999, modID, nil); err != nil || ok {
		t.Fatalf("AssignAppealForced with a nonexistent observed assignee = (%v, %v), want (false, nil)", ok, err)
	}
}

// TestAppealQueries_AssignAppealForced_ActorDemotedIsRefusedOnFreshRank is
// the inherited-P2 review: forceReassignGuarded takes actorID, not a
// pre-read position, and reads the actor's CURRENT role position fresh
// inside the same transaction as the write — so a demotion that lands
// before this call, even one a caller elsewhere might still believe is
// unchanged, is what actually governs the outcome.
func TestAppealQueries_AssignAppealForced_ActorDemotedIsRefusedOnFreshRank(t *testing.T) {
	database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-demoted", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}
	// Assigned to the plain member (position 40) — modID (position 60) would
	// ordinarily outrank them and could force-reassign.
	if ok, err := database.AssignAppeal(ctx, appealID, memberID, 0); err != nil || !ok {
		t.Fatalf("AssignAppeal: (%v, %v)", ok, err)
	}

	// modID demoted to the plain member role (also position 40) BEFORE the
	// force-reassign attempt.
	if err := database.UpdateUserRole(ctx, modID, 4); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	if _, err := database.AssignAppealForced(ctx, appealID, modID, memberID, modID, nil); !errors.Is(err, db.ErrForbidden) {
		t.Fatalf("AssignAppealForced with a freshly-demoted actor (now equal rank): want db.ErrForbidden, got %v", err)
	}
}

// TestAppealQueries_AssignAppealForced_TargetPromotedIsRefusedOnFreshRank is
// forceReassignGuarded's OTHER principal: the observed assignee's role is
// also read fresh inside the write's own transaction (its GetRoleForUser
// call, right beside the actor's rolePosition read) — a promotion that
// lands on the CURRENT assignee between the caller's earlier observation
// and this write must be what actually governs the outcome, exactly as the
// actor's own freshness does above.
func TestAppealQueries_AssignAppealForced_TargetPromotedIsRefusedOnFreshRank(t *testing.T) {
	database, ownerID, modID, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-target-promoted", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}
	// Assigned to the plain member (position 40) — modID (position 60) would
	// ordinarily outrank them and could force-reassign.
	if ok, err := database.AssignAppeal(ctx, appealID, memberID, 0); err != nil || !ok {
		t.Fatalf("AssignAppeal: (%v, %v)", ok, err)
	}

	// memberID promoted to modID's own role (now equal rank) BEFORE the
	// force-reassign attempt — a stale read of the target's position (still
	// 40) would wrongly let this succeed.
	if err := database.UpdateUserRole(ctx, memberID, 3); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	if _, err := database.AssignAppealForced(ctx, appealID, modID, memberID, modID, nil); !errors.Is(err, db.ErrForbidden) {
		t.Fatalf("AssignAppealForced against a freshly-promoted target (now equal rank): want db.ErrForbidden, got %v", err)
	}
}

func TestAppealQueries_WithdrawAppeal(t *testing.T) {
	database, ownerID, _, memberID, member2ID := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-withdraw", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}

	// A different user cannot withdraw someone else's appeal.
	if ok, err := database.WithdrawAppeal(ctx, appealID, member2ID); err != nil || ok {
		t.Fatalf("WithdrawAppeal by a non-appellant = (%v, %v), want (false, nil)", ok, err)
	}
	ok, err := database.WithdrawAppeal(ctx, appealID, memberID)
	if err != nil {
		t.Fatalf("WithdrawAppeal: %v", err)
	}
	if !ok {
		t.Fatal("WithdrawAppeal reported no row affected")
	}
	got, err := database.GetAppeal(ctx, appealID)
	if err != nil {
		t.Fatalf("GetAppeal: %v", err)
	}
	if got.State != "withdrawn" {
		t.Fatalf("state after withdraw = %q, want withdrawn", got.State)
	}
	// Nothing leaves a withdrawn state.
	if ok, err := database.WithdrawAppeal(ctx, appealID, memberID); err != nil || ok {
		t.Fatalf("re-withdrawing = (%v, %v), want (false, nil)", ok, err)
	}
}

func TestAppealQueries_CountEligibleModerators(t *testing.T) {
	database, ownerID, modID, memberID, member2ID := newAppealQueriesTestDB(t)
	ctx := context.Background()

	// Excluding the owner (as acting moderator) and member2 (as appellant),
	// only the moderator holds MODERATE_MEMBERS or Administrator.
	n, err := database.CountEligibleModerators(ctx, ownerID, member2ID, permissions.ModerateMembers, permissions.Administrator)
	if err != nil {
		t.Fatalf("CountEligibleModerators: %v", err)
	}
	if n != 1 {
		t.Fatalf("CountEligibleModerators(exclude owner) = %d, want 1 (the moderator)", n)
	}

	// Excluding the moderator, only the owner (Administrator) is left.
	n, err = database.CountEligibleModerators(ctx, modID, member2ID, permissions.ModerateMembers, permissions.Administrator)
	if err != nil {
		t.Fatalf("CountEligibleModerators: %v", err)
	}
	if n != 1 {
		t.Fatalf("CountEligibleModerators(exclude mod) = %d, want 1 (the owner)", n)
	}

	// A plain member holds neither bit and is not eligible either way.
	n, err = database.CountEligibleModerators(ctx, memberID, member2ID, permissions.ModerateMembers, permissions.Administrator)
	if err != nil {
		t.Fatalf("CountEligibleModerators: %v", err)
	}
	if n != 2 {
		t.Fatalf("CountEligibleModerators(exclude member) = %d, want 2 (owner and moderator)", n)
	}

	// F2/F3 review: the appellant exclusion matters even when the appellant
	// independently holds the bit — excluding the OWNER as appellant here
	// (instead of member2) must drop the count by one, since the owner
	// would otherwise be double-counted as an "eligible alternative" to
	// themselves.
	n, err = database.CountEligibleModerators(ctx, memberID, ownerID, permissions.ModerateMembers, permissions.Administrator)
	if err != nil {
		t.Fatalf("CountEligibleModerators: %v", err)
	}
	if n != 1 {
		t.Fatalf("CountEligibleModerators(exclude member, appellant=owner) = %d, want 1 (only the moderator)", n)
	}

	// Excluding id 0 always: a caller passing 0 for either exclusion must
	// not accidentally exempt every user with actor_id/appellant_id 0 (an
	// erased principal) — there is no such row among real users, but 0
	// itself must never count as "eligible".
	if n, err := database.CountEligibleModerators(ctx, 0, 0, permissions.ModerateMembers, permissions.Administrator); err != nil || n != 2 {
		t.Fatalf("CountEligibleModerators(0, 0) = (%d, %v), want (2, nil) — owner and moderator, id 0 itself never eligible", n, err)
	}
}

// TestAppealQueries_CountEligibleModerators_ExcludesBannedModerators is
// F2/F3 review: an effectively-banned moderator must not count as an
// eligible alternative reviewer.
func TestAppealQueries_CountEligibleModerators_ExcludesBannedModerators(t *testing.T) {
	database, ownerID, modID, memberID, member2ID := newAppealQueriesTestDB(t)
	ctx := context.Background()

	if n, err := database.CountEligibleModerators(ctx, ownerID, member2ID, permissions.ModerateMembers, permissions.Administrator); err != nil || n != 1 {
		t.Fatalf("CountEligibleModerators before ban = (%d, %v), want (1, nil)", n, err)
	}

	if err := database.BanUser(ctx, modID, "banned", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
	if n, err := database.CountEligibleModerators(ctx, ownerID, member2ID, permissions.ModerateMembers, permissions.Administrator); err != nil || n != 0 {
		t.Fatalf("CountEligibleModerators after banning the only other moderator = (%d, %v), want (0, nil)", n, err)
	}
	_ = memberID
}

// TestAppealQueries_CountEligibleModerators_LapsedBanCountsAsEligible is
// item 3: BanUser stores an ISO-8601 'Z' expiry ("2006-01-02T15:04:05Z"), and
// a raw lexical "ban_expires <= datetime('now')" compares that against
// SQLite's own space-form "now" -- a bare ' ' sorts BELOW 'T', so a ban that
// expired earlier TODAY would compare as still-active until midnight and
// wrongly exclude an otherwise-eligible moderator. A ban that expired an
// hour ago must count as eligible regardless of the wall-clock date.
func TestAppealQueries_CountEligibleModerators_LapsedBanCountsAsEligible(t *testing.T) {
	database, ownerID, modID, _, member2ID := newAppealQueriesTestDB(t)
	ctx := context.Background()

	expired := time.Now().Add(-time.Hour)
	if err := database.BanUser(ctx, modID, "spam", &expired); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
	if n, err := database.CountEligibleModerators(ctx, ownerID, member2ID, permissions.ModerateMembers, permissions.Administrator); err != nil || n != 1 {
		t.Fatalf("CountEligibleModerators with a lapsed ban = (%d, %v), want (1, nil) -- the lapsed-ban moderator still counts", n, err)
	}
}

func TestAppealQueries_GetModerationAction(t *testing.T) {
	database, ownerID, _, memberID, _ := newAppealQueriesTestDB(t)
	ctx := context.Background()

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "be nice")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	action, err := database.GetModerationAction(ctx, actionID)
	if err != nil {
		t.Fatalf("GetModerationAction: %v", err)
	}
	if action.Kind != "warning" || action.TargetID != memberID || action.ActorID != ownerID {
		t.Fatalf("GetModerationAction = %+v, want kind warning, target %d, actor %d", action, memberID, ownerID)
	}
	if _, err := database.GetModerationAction(ctx, 999999); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("GetModerationAction unknown id: want db.ErrNotFound, got %v", err)
	}
}
