package db_test

import (
	"context"
	"errors"
	"testing"

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
	ok, err = database.DecideAppeal(ctx, appealID, "upheld", ownerID, "no")
	if err != nil {
		t.Fatalf("DecideAppeal: %v", err)
	}
	if !ok {
		t.Fatal("DecideAppeal reported no row affected")
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
	if ok, err := database.DecideAppeal(ctx, appealID, "overturned", ownerID, "again"); err != nil || ok {
		t.Fatalf("re-deciding a decided appeal = (%v, %v), want (false, nil)", ok, err)
	}
	if ok, err := database.WithdrawAppeal(ctx, appealID, memberID); err != nil || ok {
		t.Fatalf("withdrawing a decided appeal = (%v, %v), want (false, nil)", ok, err)
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
	// force-reassign.
	ownerRole, err := database.GetRoleForUser(ctx, ownerID)
	if err != nil {
		t.Fatalf("GetRoleForUser(owner): %v", err)
	}
	ok, err := database.AssignAppealForced(ctx, appealID, ownerID, modID, int64(ownerRole.Position))
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
	modRole, err := database.GetRoleForUser(ctx, modID)
	if err != nil {
		t.Fatalf("GetRoleForUser(mod): %v", err)
	}
	if _, err := database.AssignAppealForced(ctx, appealID2, modID, ownerID, int64(modRole.Position)); !errors.Is(err, db.ErrForbidden) {
		t.Fatalf("AssignAppealForced without outranking: want db.ErrForbidden, got %v", err)
	}

	// A forced reassignment naming an assignee who no longer resolves to any
	// role (erased) reports (false, nil) rather than an error.
	if ok, err := database.AssignAppealForced(ctx, appealID2, modID, 999999, int64(modRole.Position)); err != nil || ok {
		t.Fatalf("AssignAppealForced with a nonexistent observed assignee = (%v, %v), want (false, nil)", ok, err)
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
	_ = member2ID

	// Excluding the owner, only the moderator holds MODERATE_MEMBERS or
	// Administrator.
	n, err := database.CountEligibleModerators(ctx, ownerID, permissions.ModerateMembers, permissions.Administrator)
	if err != nil {
		t.Fatalf("CountEligibleModerators: %v", err)
	}
	if n != 1 {
		t.Fatalf("CountEligibleModerators(exclude owner) = %d, want 1 (the moderator)", n)
	}

	// Excluding the moderator, only the owner (Administrator) is left.
	n, err = database.CountEligibleModerators(ctx, modID, permissions.ModerateMembers, permissions.Administrator)
	if err != nil {
		t.Fatalf("CountEligibleModerators: %v", err)
	}
	if n != 1 {
		t.Fatalf("CountEligibleModerators(exclude mod) = %d, want 1 (the owner)", n)
	}

	// A plain member holds neither bit and is not eligible.
	n, err = database.CountEligibleModerators(ctx, memberID, permissions.ModerateMembers, permissions.Administrator)
	if err != nil {
		t.Fatalf("CountEligibleModerators: %v", err)
	}
	if n != 2 {
		t.Fatalf("CountEligibleModerators(exclude member) = %d, want 2 (owner and moderator)", n)
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
