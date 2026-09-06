package db_test

import (
	"context"
	"errors"
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
	result, soleModerator, err := database.DecideAppealTx(ctx, appealID, "assigned", modID, "upheld", ownerID, "no",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal)
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
	result, _, err = database.DecideAppealTx(ctx, appealID, "upheld", modID, "overturned", ownerID, "again",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal)
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
		result, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "overturned", modID, "fine",
			false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal)
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
		result, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "overturned", modID, "fine",
			false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal)
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
		result, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "overturned", modID, "fine",
			false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal)
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
		result, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "overturned", modID, "fine",
			false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal)
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
	result, _, err := database.DecideAppealTx(ctx, appealID, observed.State, observed.AssigneeID, "upheld", modID, "stale",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal)
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
	result, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "upheld", modID, "no",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal)
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
	ok, err := database.AssignAppealForced(ctx, appealID, ownerID, modID, ownerID)
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
	if _, err := database.AssignAppealForced(ctx, appealID2, modID, ownerID, modID); !errors.Is(err, db.ErrForbidden) {
		t.Fatalf("AssignAppealForced without outranking: want db.ErrForbidden, got %v", err)
	}

	// A forced reassignment naming an assignee who no longer resolves to any
	// role (erased) reports (false, nil) rather than an error.
	if ok, err := database.AssignAppealForced(ctx, appealID2, modID, 999999, modID); err != nil || ok {
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
	if _, err := database.AssignAppealForced(ctx, appealID, modID, memberID, modID); !errors.Is(err, db.ErrForbidden) {
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
	if _, err := database.AssignAppealForced(ctx, appealID, modID, memberID, modID); !errors.Is(err, db.ErrForbidden) {
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
