package service

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// appealFixture wraps moderationActionsFixture (moderation_actions_test.go)
// with an AppealService over the same database, role hierarchy and
// permission service, so appeal tests inherit the B5-9 matrix's owner/mod/
// peermod/member/member2 shape without a second fixture.
type appealFixture struct {
	*moderationActionsFixture
	appeals *AppealService
}

func newAppealFixture(t *testing.T) *appealFixture {
	t.Helper()
	f := newModerationActionsFixture(t)
	limiter := auth.NewRateLimiter()
	return &appealFixture{
		moderationActionsFixture: f,
		appeals:                  NewAppealService(f.database, f.mod.perms, f.mod, limiter),
	}
}

// newSoleModeratorAppealFixture builds a database with exactly ONE user
// holding MODERATE_MEMBERS or Administrator — no owner, no admin-class
// account at all — so decision 8's self-review escape hatch (the acting
// moderator may decide their own appeal when they are the only eligible
// one) has an install to actually exercise. fixtureOwner/fixtureMod's
// shared moderationActionsFixture cannot be reused for this: its owner
// role (Administrator) would itself count as a second eligible moderator.
const (
	soleModID    = int64(1)
	soleMemberID = int64(2)
)

func newSoleModeratorAppealFixture(t *testing.T) *appealFixture {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: 1, Name: "solemod", Permissions: permissions.ModerateMembers, Position: 80})
	seedRole(t, database, &db.Role{ID: 2, Name: "solemember", Permissions: permissions.SendMessages | permissions.ReadMessages, Position: 40})
	seedUser(t, database, &db.User{ID: soleModID, Username: "solemod"})
	seedUserRole(t, database, soleModID, 1)
	seedUser(t, database, &db.User{ID: soleMemberID, Username: "solemember"})
	seedUserRole(t, database, soleMemberID, 2)

	checker := permissions.NewChecker(database)
	perms := NewPermissionService(database, checker)
	mod := NewModerationService(database, perms)
	limiter := auth.NewRateLimiter()
	return &appealFixture{
		moderationActionsFixture: &moderationActionsFixture{mod: mod, database: database},
		appeals:                  NewAppealService(database, perms, mod, limiter),
	}
}

// fakeAppealNotifier records every NotifyAppealStatus call, satisfying
// service.AppealStatusNotifier.
type fakeAppealNotifier struct {
	calls []struct {
		userID       int64
		publicID     string
		state        string
		decisionNote *string
	}
}

func (f *fakeAppealNotifier) NotifyAppealStatus(userID int64, publicID, state string, decisionNote *string) {
	f.calls = append(f.calls, struct {
		userID       int64
		publicID     string
		state        string
		decisionNote *string
	}{userID, publicID, state, decisionNote})
}

// ── Submission ───────────────────────────────────────────────────────────

func TestAppeal_OnlyTheTargetMaySubmit(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "be nice", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}

	if _, err := f.appeals.Submit(ctx, fixtureMember2, actionID, "not me"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("submit by a non-target: want ErrNotFound, got %v", err)
	}
	if _, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please reconsider"); err != nil {
		t.Fatalf("submit by the actual target: %v", err)
	}
}

// vanishingActionStore wraps a real Store and deletes actionID's row for
// real (simulating the target's account erasure cascading it away) the
// FIRST time GetModerationAction resolves it — placing the vanish exactly
// between Submit's ownership lookup and its InsertAppeal write.
type vanishingActionStore struct {
	Store
	actionID int64
	deleted  bool
}

func (s *vanishingActionStore) GetModerationAction(ctx context.Context, id int64) (*db.ModerationAction, error) {
	action, err := s.Store.GetModerationAction(ctx, id)
	if err == nil && id == s.actionID && !s.deleted {
		s.deleted = true
		if _, derr := s.Store.(*db.DB).ExecContext(ctx, `DELETE FROM moderation_actions WHERE id = ?`, id); derr != nil {
			panic(derr) // test setup failure, not a case under test
		}
	}
	return action, err
}

// TestAppeal_VanishedActionMapsToTheSameNotFoundShapeAsUnknown is N4: an
// action erased between Submit's ownership lookup and its InsertAppeal
// write must produce the EXACT SAME refusal (error value, hence the same
// wire shape) as an action id that never existed — no existence oracle
// either way, matching TestAppeal_OnlyTheTargetMaySubmit's identical
// refusal for "not mine".
func TestAppeal_VanishedActionMapsToTheSameNotFoundShapeAsUnknown(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "be nice", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}

	vs := &vanishingActionStore{Store: f.database, actionID: actionID}
	appeals := NewAppealService(vs, f.mod.perms, f.mod, auth.NewRateLimiter())

	_, vanishedErr := appeals.Submit(ctx, fixtureMember, actionID, "please")
	_, unknownErr := f.appeals.Submit(ctx, fixtureMember, 999999, "please")

	if !errors.Is(vanishedErr, ErrNotFound) {
		t.Fatalf("Submit against a vanished action: want ErrNotFound, got %v", vanishedErr)
	}
	if !errors.Is(unknownErr, ErrNotFound) {
		t.Fatalf("Submit against an unknown action: want ErrNotFound, got %v", unknownErr)
	}
	if vanishedErr.Error() != unknownErr.Error() {
		t.Fatalf("vanished-action refusal (%q) and unknown-action refusal (%q) differ — an existence oracle", vanishedErr, unknownErr)
	}
}

func TestAppeal_OnePerActionEver(t *testing.T) {
	ctx := context.Background()

	t.Run("second submit", func(t *testing.T) {
		f := newAppealFixture(t)
		actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
		if err != nil {
			t.Fatalf("Warn: %v", err)
		}
		if _, err := f.appeals.Submit(ctx, fixtureMember, actionID, "first"); err != nil {
			t.Fatalf("first submit: %v", err)
		}
		if _, err := f.appeals.Submit(ctx, fixtureMember, actionID, "second"); !errors.Is(err, ErrAlreadyAppealed) {
			t.Fatalf("second submit: want ErrAlreadyAppealed, got %v", err)
		}
	})

	t.Run("after decision", func(t *testing.T) {
		f := newAppealFixture(t)
		actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
		if err != nil {
			t.Fatalf("Warn: %v", err)
		}
		publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, "first")
		if err != nil {
			t.Fatalf("submit: %v", err)
		}
		if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "no"); err != nil {
			t.Fatalf("Decide: %v", err)
		}
		if _, err := f.appeals.Submit(ctx, fixtureMember, actionID, "again"); !errors.Is(err, ErrAlreadyAppealed) {
			t.Fatalf("re-submit after decision: want ErrAlreadyAppealed, got %v", err)
		}
	})

	// A genuinely concurrent pair, mirroring TestAppeal_ConcurrentDecideOneWins:
	// FindAppealForAction's pre-check and InsertAppeal are two separate
	// statements, so two real goroutines can both pass the pre-check before
	// either commits its insert — decision 8's actual race-proof is the
	// UNIQUE(action_id) constraint InsertAppeal hits, not the pre-check
	// alone, and this must still leave exactly one 201. This is a
	// scheduler-luck smoke test at the service layer; the barrier-forced
	// version that guarantees both goroutines are genuinely in flight
	// together at the INSERT itself (not merely hoping the scheduler
	// interleaves them) is db.TestAppealQueries_InsertAppealConcurrentBothInFlight.
	t.Run("concurrent submit", func(t *testing.T) {
		f := newAppealFixture(t)
		actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
		if err != nil {
			t.Fatalf("Warn: %v", err)
		}

		var wg sync.WaitGroup
		type outcome struct {
			publicID string
			err      error
		}
		results := make([]outcome, 2)
		for i := range 2 {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				pid, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please")
				results[i] = outcome{publicID: pid, err: err}
			}(i)
		}
		wg.Wait()

		successes := 0
		for _, r := range results {
			if r.err == nil {
				successes++
				if r.publicID == "" {
					t.Error("a successful concurrent submit returned an empty public id")
				}
			} else if !errors.Is(r.err, ErrAlreadyAppealed) {
				t.Errorf("concurrent submit: unexpected error %v", r.err)
			}
		}
		if successes != 1 {
			t.Fatalf("concurrent submits succeeded = %d, want exactly 1", successes)
		}
	})

	t.Run("after withdraw", func(t *testing.T) {
		f := newAppealFixture(t)
		actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
		if err != nil {
			t.Fatalf("Warn: %v", err)
		}
		publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, "first")
		if err != nil {
			t.Fatalf("submit: %v", err)
		}
		if err := f.appeals.Withdraw(ctx, fixtureMember, publicID); err != nil {
			t.Fatalf("Withdraw: %v", err)
		}
		if _, err := f.appeals.Submit(ctx, fixtureMember, actionID, "again"); !errors.Is(err, ErrAlreadyAppealed) {
			t.Fatalf("re-submit after withdraw: want ErrAlreadyAppealed, got %v", err)
		}
	})
}

func TestAppeal_RateLimit(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionIDs := make([]int64, 0, 4)
	for range 4 {
		id, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
		if err != nil {
			t.Fatalf("Warn: %v", err)
		}
		actionIDs = append(actionIDs, id)
	}

	for i, id := range actionIDs[:3] {
		if _, err := f.appeals.Submit(ctx, fixtureMember, id, "please"); err != nil {
			t.Fatalf("submit %d: %v", i, err)
		}
	}
	if _, err := f.appeals.Submit(ctx, fixtureMember, actionIDs[3], "please"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("4th submission in the window: want ErrRateLimited, got %v", err)
	}
}

func TestAppeal_KickIsNotAppealable(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionID, err := f.database.ForceLogoutWithAction(ctx, fixtureMember, fixtureMod, nil, "kicked")
	if err != nil {
		t.Fatalf("ForceLogoutWithAction: %v", err)
	}
	if _, err := f.appeals.Submit(ctx, fixtureMember, actionID, "let me back in"); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("appeal against a kick: want ErrBadRequest, got %v", err)
	}
}

// TestAppeal_RateLimitKeyIndependentOfReports is the revert-proof case for
// the appeal rate limit's key: exhausting the "report" bucket for a user
// must never consume their "appeal" allowance, and vice versa — the two
// features share one *auth.RateLimiter instance but must never share a key
// prefix (auth.Key("appeal", ...) vs auth.Key("report", ...)).
func TestAppeal_RateLimitKeyIndependentOfReports(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	for range 5 {
		f.appeals.limiter.Allow(auth.Key("report", fixtureMember), 5, 10*time.Minute)
	}

	actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	if _, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please"); err != nil {
		t.Fatalf("Submit after exhausting the report bucket: %v (the appeal key must be independent)", err)
	}
}

// TestAppeal_AdministratorCountsAsEligibleModerator is the revert-proof
// case for checkSelfReview's eligible-moderator count: an Administrator who
// holds no MODERATE_MEMBERS bit of their own must still count as a second
// eligible moderator, refusing the acting moderator's sole-moderator escape.
func TestAppeal_AdministratorCountsAsEligibleModerator(t *testing.T) {
	f := newSoleModeratorAppealFixture(t)
	ctx := context.Background()
	seedRole(t, f.database, &db.Role{ID: 3, Name: "owner", Permissions: permissions.Administrator, Position: 100})
	seedUser(t, f.database, &db.User{ID: 99, Username: "owner99"})
	seedUserRole(t, f.database, 99, 3)

	actionID, err := f.mod.Warn(ctx, soleModID, soleMemberID, "x", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, soleMemberID, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if err := f.appeals.Decide(ctx, soleModID, publicID, "upheld", "self-serving"); !errors.Is(err, ErrSelfReview) {
		t.Fatalf("acting moderator deciding their own appeal with an Administrator present: want ErrSelfReview, got %v", err)
	}
}

// ── State machine ────────────────────────────────────────────────────────

func TestAppeal_StateMachine(t *testing.T) {
	newOpen := func(t *testing.T, f *appealFixture) string {
		t.Helper()
		actionID, err := f.mod.Warn(context.Background(), fixtureMod, fixtureMember, "x", nil)
		if err != nil {
			t.Fatalf("Warn: %v", err)
		}
		publicID, err := f.appeals.Submit(context.Background(), fixtureMember, actionID, "please")
		if err != nil {
			t.Fatalf("Submit: %v", err)
		}
		return publicID
	}

	t.Run("open to assigned", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		if err := f.appeals.Assign(context.Background(), fixturePeerMod, publicID, false); err != nil {
			t.Fatalf("Assign: %v", err)
		}
	})

	t.Run("open directly to upheld", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		if err := f.appeals.Decide(context.Background(), fixturePeerMod, publicID, "upheld", ""); err != nil {
			t.Fatalf("Decide: %v", err)
		}
	})

	t.Run("open directly to overturned", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		if err := f.appeals.Decide(context.Background(), fixturePeerMod, publicID, "overturned", ""); err != nil {
			t.Fatalf("Decide: %v", err)
		}
	})

	t.Run("assigned to upheld", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		if err := f.appeals.Assign(context.Background(), fixturePeerMod, publicID, false); err != nil {
			t.Fatalf("Assign: %v", err)
		}
		if err := f.appeals.Decide(context.Background(), fixturePeerMod, publicID, "upheld", ""); err != nil {
			t.Fatalf("Decide: %v", err)
		}
	})

	t.Run("open to withdrawn by the appellant", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		if err := f.appeals.Withdraw(context.Background(), fixtureMember, publicID); err != nil {
			t.Fatalf("Withdraw: %v", err)
		}
	})

	t.Run("assigned to withdrawn by the appellant", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		if err := f.appeals.Assign(context.Background(), fixturePeerMod, publicID, false); err != nil {
			t.Fatalf("Assign: %v", err)
		}
		if err := f.appeals.Withdraw(context.Background(), fixtureMember, publicID); err != nil {
			t.Fatalf("Withdraw: %v", err)
		}
	})

	t.Run("nothing leaves upheld", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		if err := f.appeals.Decide(context.Background(), fixturePeerMod, publicID, "upheld", ""); err != nil {
			t.Fatalf("Decide: %v", err)
		}
		if err := f.appeals.Assign(context.Background(), fixturePeerMod, publicID, false); !errors.Is(err, ErrConflict) {
			t.Fatalf("assign a decided appeal: want ErrConflict, got %v", err)
		}
		if err := f.appeals.Decide(context.Background(), fixturePeerMod, publicID, "overturned", ""); !errors.Is(err, ErrConflict) {
			t.Fatalf("re-decide a decided appeal: want ErrConflict, got %v", err)
		}
		if err := f.appeals.Withdraw(context.Background(), fixtureMember, publicID); !errors.Is(err, ErrConflict) {
			t.Fatalf("withdraw a decided appeal: want ErrConflict, got %v", err)
		}
	})

	t.Run("nothing leaves withdrawn", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		if err := f.appeals.Withdraw(context.Background(), fixtureMember, publicID); err != nil {
			t.Fatalf("Withdraw: %v", err)
		}
		if err := f.appeals.Assign(context.Background(), fixturePeerMod, publicID, false); !errors.Is(err, ErrConflict) {
			t.Fatalf("assign a withdrawn appeal: want ErrConflict, got %v", err)
		}
		if err := f.appeals.Decide(context.Background(), fixturePeerMod, publicID, "upheld", ""); !errors.Is(err, ErrConflict) {
			t.Fatalf("decide a withdrawn appeal: want ErrConflict, got %v", err)
		}
	})
}

func TestAppeal_WithdrawIsAppellantOnly(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	if err := f.appeals.Withdraw(ctx, fixturePeerMod, publicID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("withdraw by a moderator: want ErrNotFound, got %v", err)
	}
	if err := f.appeals.Withdraw(ctx, fixtureMember2, publicID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("withdraw by another member: want ErrNotFound, got %v", err)
	}
	if err := f.appeals.Withdraw(ctx, fixtureMember, publicID); err != nil {
		t.Fatalf("withdraw by the appellant: %v", err)
	}
}

// ── The deciding-moderator rule ──────────────────────────────────────────

func TestAppeal_ActingModeratorMayNotDecideWhereAnotherExists(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	// fixtureMod acted; fixturePeerMod is a second eligible moderator
	// (moderationActionsFixture grants both ModerateMembers).
	actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	if err := f.appeals.Decide(ctx, fixtureMod, publicID, "upheld", "self-serving"); !errors.Is(err, ErrSelfReview) {
		t.Fatalf("acting moderator deciding their own appeal: want ErrSelfReview, got %v", err)
	}
	// The other eligible moderator may decide it.
	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "fine"); err != nil {
		t.Fatalf("Decide by the other moderator: %v", err)
	}
}

// TestAppeal_AppellantMayNotDecideOrAssignOwnAppealEvenAsModerator is a
// distinct rule from the acting-moderator self-review check above: an
// appellant who independently holds MODERATE_MEMBERS must never assign or
// decide the very appeal THEY filed, with no sole-moderator escape (there
// is no honest "forced to judge your own case" argument for the appellant
// the way there is for the acting moderator on a one-admin install).
func TestAppeal_AppellantMayNotDecideOrAssignOwnAppealEvenAsModerator(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	// fixtureOwner (Administrator) warns fixturePeerMod, who holds
	// MODERATE_MEMBERS in their own right — the appellant here is also a
	// moderator, but did not take the appealed action.
	actionID, err := f.mod.Warn(ctx, fixtureOwner, fixturePeerMod, "x", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixturePeerMod, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	if err := f.appeals.Assign(ctx, fixturePeerMod, publicID, false); !errors.Is(err, ErrSelfReview) {
		t.Fatalf("appellant assigning their own appeal: want ErrSelfReview, got %v", err)
	}
	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "self-approved"); !errors.Is(err, ErrSelfReview) {
		t.Fatalf("appellant deciding their own appeal: want ErrSelfReview, got %v", err)
	}
	// An uninvolved moderator may still decide it.
	if err := f.appeals.Decide(ctx, fixtureMod, publicID, "upheld", "fine"); err != nil {
		t.Fatalf("Decide by an uninvolved moderator: %v", err)
	}
}

// TestAppeal_ActingModeratorMayNotAssignWhereAnotherExists is Claim 6: the
// symmetric rule to TestAppeal_ActingModeratorMayNotDecideWhereAnotherExists
// applied to Assign instead of Decide — the moderator who took the
// appealed action may not assign it to themself either, where another
// eligible reviewer exists.
func TestAppeal_ActingModeratorMayNotAssignWhereAnotherExists(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	if err := f.appeals.Assign(ctx, fixtureMod, publicID, false); !errors.Is(err, ErrSelfReview) {
		t.Fatalf("acting moderator assigning their own appealed action to themself: want ErrSelfReview, got %v", err)
	}
	// The other eligible moderator may still assign it.
	if err := f.appeals.Assign(ctx, fixturePeerMod, publicID, false); err != nil {
		t.Fatalf("Assign by the other moderator: %v", err)
	}
}

func TestAppeal_SoleModeratorMayDecideAndAuditSaysSo(t *testing.T) {
	f := newSoleModeratorAppealFixture(t)
	ctx := context.Background()

	actionID, err := f.mod.Warn(ctx, soleModID, soleMemberID, "x", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, soleMemberID, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	rec := audittest.Install(t, f.database)
	if err := f.appeals.Decide(ctx, soleModID, publicID, "upheld", "only mod here"); err != nil {
		t.Fatalf("sole moderator deciding their own appeal: %v", err)
	}
	entry := rec.Wait(t, "appeal_decide")
	if !strings.Contains(entry.Detail, "sole moderator") {
		t.Fatalf("appeal_decide audit detail = %q, want it to name \"sole moderator\"", entry.Detail)
	}
}

// TestAppeal_OverturnAuditsBothTheDecisionAndTheReversalWithDistinctActors
// is item 4: overturning writes TWO audit rows — appeal_decide, actor the
// human decider (the accountable decision), and the kind-specific reversal
// (user_untimeout here), actor 0 (a mechanical consequence of the decision,
// not a second moderation action by that human — the same convention
// LiftTimeoutByActionID's lifted_by=0 already uses). The reversal row's
// detail names the appeal's public id; neither row ever carries the appeal
// body or the decision note.
func TestAppeal_OverturnAuditsBothTheDecisionAndTheReversalWithDistinctActors(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	const body = "appeal body sentinel 4-item"
	const note = "decision note sentinel 4-item"
	result, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil)
	if err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, result.ID, body)
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	rec := audittest.Install(t, f.database)
	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", note); err != nil {
		t.Fatalf("Decide: %v", err)
	}

	decideEntry := rec.Wait(t, "appeal_decide")
	if decideEntry.ActorID != fixturePeerMod {
		t.Fatalf("appeal_decide actor = %d, want the human decider %d", decideEntry.ActorID, fixturePeerMod)
	}
	reversalEntry := rec.Wait(t, "user_untimeout")
	if reversalEntry.ActorID != 0 {
		t.Fatalf("user_untimeout actor = %d, want 0 (a mechanical consequence of the decision)", reversalEntry.ActorID)
	}
	if !strings.Contains(reversalEntry.Detail, publicID) {
		t.Fatalf("user_untimeout detail = %q, want it to name the appeal %q", reversalEntry.Detail, publicID)
	}
	for _, e := range rec.Entries() {
		if strings.Contains(e.Detail, body) || strings.Contains(e.Detail, note) {
			t.Fatalf("audit %q detail carries the appeal body or note: %q", e.Action, e.Detail)
		}
	}
}

// ── Effects ──────────────────────────────────────────────────────────────

func TestAppeal_OverturnLiftsTimeoutUnbansAcknowledgesWarning(t *testing.T) {
	ctx := context.Background()

	t.Run("timeout", func(t *testing.T) {
		f := newAppealFixture(t)
		result, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil)
		if err != nil {
			t.Fatalf("Timeout: %v", err)
		}
		publicID, err := f.appeals.Submit(ctx, fixtureMember, result.ID, "please")
		if err != nil {
			t.Fatalf("Submit: %v", err)
		}
		if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"); err != nil {
			t.Fatalf("Decide: %v", err)
		}
		active, err := f.database.HasActiveTimeout(ctx, fixtureMember)
		if err != nil {
			t.Fatalf("HasActiveTimeout: %v", err)
		}
		if active {
			t.Fatal("timeout still active after the appeal was overturned")
		}
	})

	t.Run("ban", func(t *testing.T) {
		f := newAppealFixture(t)
		if err := f.mod.BanUser(ctx, fixtureMod, fixtureMember, "spam", nil); err != nil {
			t.Fatalf("BanUser: %v", err)
		}
		rows, err := f.database.ListModerationActionsForTarget(ctx, fixtureMember)
		if err != nil {
			t.Fatalf("ListModerationActionsForTarget: %v", err)
		}
		var actionID int64
		for _, r := range rows {
			if r.Kind == "ban" {
				actionID = r.ID
			}
		}
		if actionID == 0 {
			t.Fatal("no ban ledger row found")
		}
		// The banned member cannot themselves reach Submit in production
		// (AuthMiddleware rejects every effectively-banned caller) — this
		// unit test drives the service directly, standing in for "the ban
		// has since lapsed or been reversed" per the narrow ban-appeal path.
		publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please")
		if err != nil {
			t.Fatalf("Submit: %v", err)
		}
		if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"); err != nil {
			t.Fatalf("Decide: %v", err)
		}
		target, err := f.database.GetUserByID(ctx, fixtureMember)
		if err != nil {
			t.Fatalf("GetUserByID: %v", err)
		}
		if target.Banned {
			t.Fatal("target still banned after the appeal was overturned")
		}
	})

	t.Run("warning", func(t *testing.T) {
		f := newAppealFixture(t)
		actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
		if err != nil {
			t.Fatalf("Warn: %v", err)
		}
		publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please")
		if err != nil {
			t.Fatalf("Submit: %v", err)
		}
		if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"); err != nil {
			t.Fatalf("Decide: %v", err)
		}
		notices, err := f.database.ListUnacknowledgedWarnings(ctx, fixtureMember)
		if err != nil {
			t.Fatalf("ListUnacknowledgedWarnings: %v", err)
		}
		if len(notices) != 0 {
			t.Fatalf("unacknowledged notices after overturning a warning = %d, want 0", len(notices))
		}
	})
}

// TestAppeal_OverturnReversesOnlyTheSpecificAppealedTimeout is N1: overturn
// must reverse the SPECIFICALLY appealed action, never "whatever timeout is
// active for this target now". A second Timeout call supersedes (lifts) the
// first, so appealing the OLDER (already-superseded) one and overturning it
// must be a record only — the newer timeout, still active, must survive
// completely untouched. Before N1, overturn looked up "the target's current
// active timeout" instead of the appealed action's own id, and would have
// wrongly lifted the newer one here.
func TestAppeal_OverturnReversesOnlyTheSpecificAppealedTimeout(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	olderResult, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "first", time.Hour, nil)
	if err != nil {
		t.Fatalf("Timeout (older): %v", err)
	}
	newerResult, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "second", 2*time.Hour, nil)
	if err != nil {
		t.Fatalf("Timeout (newer): %v", err)
	}
	if olderResult.ID == newerResult.ID {
		t.Fatal("the two Timeout calls returned the same action id")
	}

	// The older timeout is already superseded (lifted) by the newer one —
	// appealing it anyway (the target may not know which of two attempts a
	// notice referred to) must not disturb the newer, still-active row.
	publicID, err := f.appeals.Submit(ctx, fixtureMember, olderResult.ID, "please")
	if err != nil {
		t.Fatalf("Submit against the older (superseded) timeout: %v", err)
	}
	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"); err != nil {
		t.Fatalf("Decide: %v", err)
	}

	active, err := f.database.HasActiveTimeout(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("HasActiveTimeout: %v", err)
	}
	if !active {
		t.Fatal("the newer timeout is no longer active after overturning the OLDER, already-superseded one")
	}
	rows, err := f.database.ListModerationActionsForTarget(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	for i := range rows {
		if r := &rows[i]; r.ID == newerResult.ID && r.LiftedAt != nil {
			t.Fatalf("the newer timeout (action %d) was lifted by overturning a different action", newerResult.ID)
		}
	}
}

// TestAppeal_OverturnFirstBanDoesNotUnbanAfterReban is N1's ban case: ban,
// unban, re-ban, then overturn the FIRST ban's appeal — the target must
// still be banned, because a strictly newer ban action (the re-ban) governs
// their current state. applyAppealReversalTx's ban reversal only unbans
// when no newer ban action exists for the target; here one does.
func TestAppeal_OverturnFirstBanDoesNotUnbanAfterReban(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	if err := f.mod.BanUser(ctx, fixtureMod, fixtureMember, "first offense", nil); err != nil {
		t.Fatalf("BanUser (first): %v", err)
	}
	firstBanID := latestActionOfKind(t, ctx, f, fixtureMember, "ban")

	if err := f.mod.UnbanUser(ctx, fixtureMod, fixtureMember); err != nil {
		t.Fatalf("UnbanUser: %v", err)
	}
	if err := f.mod.BanUser(ctx, fixtureMod, fixtureMember, "second offense", nil); err != nil {
		t.Fatalf("BanUser (second): %v", err)
	}
	secondBanID := latestActionOfKind(t, ctx, f, fixtureMember, "ban")
	if firstBanID == secondBanID {
		t.Fatal("the two BanUser calls returned the same action id")
	}

	// Appealing the FIRST ban, now superseded by the re-ban.
	publicID, err := f.appeals.Submit(ctx, fixtureMember, firstBanID, "please")
	if err != nil {
		t.Fatalf("Submit against the first ban: %v", err)
	}
	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"); err != nil {
		t.Fatalf("Decide: %v", err)
	}

	target, err := f.database.GetUserByID(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if !target.Banned {
		t.Fatal("target is unbanned after overturning the FIRST ban — the re-ban should still govern")
	}
}

// TestAppeal_OverturnRemovalIsRecordOnly covers applyAppealReversalTx's
// "removal" branch: there is nothing to restore (the content is gone), so
// overturning a removal appeal must still commit cleanly as a record-only
// decision — no error, no panic, just the appeal's own state flipping.
func TestAppeal_OverturnRemovalIsRecordOnly(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	msgID, err := f.database.CreateMessage(ctx, fixtureChannel, fixtureMember2, "reported content", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	result, err := f.mod.ActOnReport(ctx, ActOnReportParams{
		ActorID: fixtureMod, Kind: "removal", Reason: "linked removal", MessageID: msgID, ReportID: 999,
	})
	if err != nil {
		t.Fatalf("ActOnReport(removal): %v", err)
	}
	rows, err := f.database.ListModerationActionsForTarget(ctx, fixtureMember2)
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
		t.Fatalf("no removal ledger row found (result=%+v)", result)
	}

	publicID, err := f.appeals.Submit(ctx, fixtureMember2, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"); err != nil {
		t.Fatalf("Decide(removal, overturned): %v", err)
	}
	appeal, err := f.database.GetAppealByPublicID(ctx, publicID)
	if err != nil {
		t.Fatalf("GetAppealByPublicID: %v", err)
	}
	if appeal.State != "overturned" {
		t.Fatalf("appeal state = %q, want overturned", appeal.State)
	}
}

// latestActionOfKind returns the highest-id moderation_actions row of kind
// for targetID — a test helper for scenarios that create the same kind
// twice against the same target and need to name each action id distinctly.
func latestActionOfKind(t *testing.T, ctx context.Context, f *appealFixture, targetID int64, kind string) int64 {
	t.Helper()
	rows, err := f.database.ListModerationActionsForTarget(ctx, targetID)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	var latest int64
	for i := range rows {
		if r := &rows[i]; r.Kind == kind && r.ID > latest {
			latest = r.ID
		}
	}
	if latest == 0 {
		t.Fatalf("no %q action found for target %d", kind, targetID)
	}
	return latest
}

// TestAppeal_OverturnSucceedsWithoutOutrankOrMuteMembers is F1's own test:
// a decider who holds MODERATE_MEMBERS but does NOT outrank the sanctioned
// target — the gate ModerationService.LiftTimeout itself would refuse —
// must still be able to overturn the appeal and have the timeout lifted,
// because the reversal is a store-level consequence of the DECISION (which
// only ever required MODERATE_MEMBERS), not a second moderation action
// routed back through LiftTimeout's own outrank/MUTE_MEMBERS gates.
func TestAppeal_OverturnSucceedsWithoutOutrankOrMuteMembers(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	// A moderator role that holds MODERATE_MEMBERS but sits BELOW
	// fixtureMember's own rank (position 40) — LiftTimeout's outrank check
	// would refuse this actor outright.
	seedRole(t, f.database, &db.Role{ID: 6, Name: "lowrankmod", Permissions: permissions.ModerateMembers, Position: 10})
	const lowRankModID = int64(7)
	seedUser(t, f.database, &db.User{ID: lowRankModID, Username: "lowrankmod"})
	seedUserRole(t, f.database, lowRankModID, 6)

	result, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil)
	if err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, result.ID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	// Sanity: the OLD path (ModerationService.LiftTimeout) really does
	// refuse this actor, so the test below is not accidentally vacuous.
	if err := f.mod.LiftTimeout(ctx, lowRankModID, fixtureMember); !errors.Is(err, ErrForbidden) {
		t.Fatalf("sanity: ModerationService.LiftTimeout(lowRankModID): want ErrForbidden, got %v", err)
	}

	if err := f.appeals.Decide(ctx, lowRankModID, publicID, "overturned", "fine"); err != nil {
		t.Fatalf("Decide by a non-outranking MODERATE_MEMBERS holder: %v", err)
	}
	active, err := f.database.HasActiveTimeout(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("HasActiveTimeout: %v", err)
	}
	if active {
		t.Fatal("timeout still active after a non-outranking decider overturned the appeal")
	}
	appeal, err := f.database.GetAppealByPublicID(ctx, publicID)
	if err != nil {
		t.Fatalf("GetAppealByPublicID: %v", err)
	}
	if appeal.State != "overturned" {
		t.Fatalf("appeal state = %q, want overturned (the decision must commit)", appeal.State)
	}
}

// TestAppeal_DecideDoesNotNotifyOnFailure is the notification half of F1: a
// Decide call that returns an error (for any reason — this one uses the
// simplest, an already-decided appeal) must never fire the appeal_status
// notification. db/appeal_reversal_test.go covers the reversal-specific
// half (a forced reversal failure rolls back the whole transaction) at the
// db layer, where the test-only fault-injection hook actually lives.
func TestAppeal_DecideDoesNotNotifyOnFailure(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "no"); err != nil {
		t.Fatalf("first Decide: %v", err)
	}

	notifier := &fakeAppealNotifier{}
	f.appeals.SetNotifier(notifier)

	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "again"); !errors.Is(err, ErrConflict) {
		t.Fatalf("re-deciding a decided appeal: want ErrConflict, got %v", err)
	}
	if len(notifier.calls) != 0 {
		t.Fatalf("appeal_status notify calls = %d, want 0 for a failed Decide", len(notifier.calls))
	}
}

// appealOrderRecorder records every notify call's order across BOTH
// channels (appeal_status and mod_queue) in one shared, lock-protected
// slice — F4's own test needs the two interleaved to prove one transition's
// pair never lands between another's.
type appealOrderRecorder struct {
	mu     syncutil.Mutex
	events []string
}

func (r *appealOrderRecorder) add(s string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, s)
}

func (r *appealOrderRecorder) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.events...)
}

type orderedStatusNotifier struct{ rec *appealOrderRecorder }

func (n *orderedStatusNotifier) NotifyAppealStatus(userID int64, publicID, state string, note *string) {
	n.rec.add("status:" + state)
}

type orderedQueueBroadcaster struct{ rec *appealOrderRecorder }

func (b *orderedQueueBroadcaster) BroadcastAppealQueue(ctx context.Context, appealID int64, state string) {
	b.rec.add("queue:" + state)
}

// TestAppeal_AssignThenDecideNotifyOrderMatchesCommitOrder is F4: Assign's
// write commits, then — before Assign has notified anyone — a concurrent
// Decide runs to completion (write, audit, both notifies). F4's per-appeal
// lock must force Decide to wait for Assign's own notify pair before it can
// even begin its write, so every notify (appeal_status AND mod_queue) lands
// in commit order: assigned, assigned, overturned, overturned — never a
// stale "assigned" trailing behind "overturned".
func TestAppeal_AssignThenDecideNotifyOrderMatchesCommitOrder(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	rec := &appealOrderRecorder{}
	f.appeals.SetNotifier(&orderedStatusNotifier{rec: rec})
	f.appeals.SetQueueBroadcaster(&orderedQueueBroadcaster{rec: rec})

	reached := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	appealPostWriteHookForTest = func(pid string) {
		if pid != publicID {
			return
		}
		once.Do(func() { close(reached) })
		<-release
	}
	defer func() { appealPostWriteHookForTest = nil }()

	assignDone := make(chan error, 1)
	go func() {
		assignDone <- f.appeals.Assign(ctx, fixturePeerMod, publicID, false)
	}()

	select {
	case <-reached:
	case <-time.After(5 * time.Second):
		t.Fatal("Assign never reached the post-write hook — the barrier never armed")
	}

	decideDone := make(chan error, 1)
	go func() {
		decideDone <- f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine")
	}()
	// Best-effort: give Decide's goroutine a moment to actually queue behind
	// the appeal's own lock before releasing Assign's hook — the correctness
	// claim holds regardless (the lock, not timing, is what orders them),
	// this only makes the race more likely to be genuinely in flight.
	time.Sleep(20 * time.Millisecond)
	close(release)

	if err := <-assignDone; err != nil {
		t.Fatalf("Assign: %v", err)
	}
	if err := <-decideDone; err != nil {
		t.Fatalf("Decide: %v", err)
	}

	want := []string{"status:assigned", "queue:assigned", "status:overturned", "queue:overturned"}
	if got := rec.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("notify order = %v, want %v", got, want)
	}
}

// TestAppeal_DelayedAssignAfterDecisionDoesNotBroadcast is F4: a delayed
// Assign that finally reaches the database after the appeal was already
// decided must fail on the same guarded UPDATE Claim 5 added (the appeal's
// state is no longer "open"/"assigned", so the write affects zero rows) —
// and, critically, must NOT emit an "assigned" appeal_status frame, which
// would otherwise arrive at the appellant's socket AFTER the "overturned"
// or "upheld" frame it already received.
func TestAppeal_DelayedAssignAfterDecisionDoesNotBroadcast(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"); err != nil {
		t.Fatalf("Decide: %v", err)
	}

	notifier := &fakeAppealNotifier{}
	f.appeals.SetNotifier(notifier)

	if err := f.appeals.Assign(ctx, fixturePeerMod, publicID, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("delayed assign after decision: want ErrConflict, got %v", err)
	}
	if len(notifier.calls) != 0 {
		t.Fatalf("appeal_status notify calls = %d, want 0 — a refused assign must never broadcast", len(notifier.calls))
	}
}

func TestAppeal_UpholdChangesNothing(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	result, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil)
	if err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, result.ID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "no"); err != nil {
		t.Fatalf("Decide: %v", err)
	}
	active, err := f.database.HasActiveTimeout(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("HasActiveTimeout: %v", err)
	}
	if !active {
		t.Fatal("timeout no longer active after upholding — upholding must change nothing")
	}
}

// ── The queue ────────────────────────────────────────────────────────────

func TestAppeal_QueueRequiresTheBit(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	if _, err := f.appeals.Queue(ctx, fixtureMember, ""); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Queue by a plain member: want ErrForbidden, got %v", err)
	}
	if _, err := f.appeals.Queue(ctx, fixtureMod, ""); err != nil {
		t.Fatalf("Queue by a moderator: %v", err)
	}
}

// TestAppeal_QueueExcludesTheCallersOwnAppeal is F5: a moderator-appellant
// must not learn who is assigned to, or how the queue is filling up
// around, their OWN appeal through the surface built for reviewing OTHER
// people's — even though the row would otherwise match the requested state.
func TestAppeal_QueueExcludesTheCallersOwnAppeal(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	// fixtureOwner warns fixturePeerMod, who independently holds
	// MODERATE_MEMBERS — the appellant here is also a moderator viewing the
	// queue.
	actionID, err := f.mod.Warn(ctx, fixtureOwner, fixturePeerMod, "x", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixturePeerMod, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	rows, err := f.appeals.Queue(ctx, fixturePeerMod, "")
	if err != nil {
		t.Fatalf("Queue: %v", err)
	}
	for _, r := range rows {
		if r.PublicID == publicID {
			t.Fatalf("Queue for the appellant themself included their own appeal %q", publicID)
		}
	}
	// An uninvolved moderator sees it.
	rows, err = f.appeals.Queue(ctx, fixtureMod, "")
	if err != nil {
		t.Fatalf("Queue by an uninvolved moderator: %v", err)
	}
	found := false
	for _, r := range rows {
		if r.PublicID == publicID {
			found = true
		}
	}
	if !found {
		t.Fatalf("Queue by an uninvolved moderator did not include appeal %q", publicID)
	}
}

// TestAppeal_GetRefusesTheCallersOwnAppeal is F5's read-side guard: a
// moderator-appellant is refused ErrSelfReview (403) on their own appeal's
// detail view, which would otherwise show them who is assigned, who
// decided, and the acting moderator's identity.
func TestAppeal_GetRefusesTheCallersOwnAppeal(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionID, err := f.mod.Warn(ctx, fixtureOwner, fixturePeerMod, "x", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixturePeerMod, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	if _, err := f.appeals.Get(ctx, fixturePeerMod, publicID); !errors.Is(err, ErrSelfReview) {
		t.Fatalf("Get by the appellant themself: want ErrSelfReview, got %v", err)
	}
	if _, err := f.appeals.Get(ctx, fixtureMod, publicID); err != nil {
		t.Fatalf("Get by an uninvolved moderator: %v", err)
	}
}

// ── Concurrency ──────────────────────────────────────────────────────────

func TestAppeal_ConcurrentDecideOneWins(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	var wg sync.WaitGroup
	results := make([]error, 2)
	outcomes := []string{"upheld", "overturned"}
	for i := range 2 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = f.appeals.Decide(ctx, fixturePeerMod, publicID, outcomes[i], "race")
		}(i)
	}
	wg.Wait()

	successes := 0
	for _, err := range results {
		if err == nil {
			successes++
		} else if !errors.Is(err, ErrConflict) {
			t.Errorf("concurrent decide: unexpected error %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("concurrent decides succeeded = %d, want exactly 1", successes)
	}
}

// ── Erasure ──────────────────────────────────────────────────────────────

// TestAppeal_DecidingModeratorErasureUnlinks assigns before deciding, so
// the SAME erased moderator's id sits in both assignee_id (no token column,
// bare id, inventory class 24c) and decided_by (bare-id-plus-token,
// inventory class 24b). A non-empty subject token proves erasure keeps the
// audit history's token (a real deployment always passes one) rather than
// merely proving the zero-value default happens to also be zero.
func TestAppeal_DecidingModeratorErasureUnlinks(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "x", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if err := f.appeals.Assign(ctx, fixturePeerMod, publicID, false); err != nil {
		t.Fatalf("Assign: %v", err)
	}
	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "no"); err != nil {
		t.Fatalf("Decide: %v", err)
	}

	const token = "erased-mod-token"
	if _, err := f.database.EraseAccount(ctx, fixturePeerMod, token); err != nil {
		t.Fatalf("EraseAccount(deciding moderator): %v", err)
	}

	appeal, err := f.database.GetAppealByPublicID(ctx, publicID)
	if err != nil {
		t.Fatalf("GetAppealByPublicID after erasure: %v", err)
	}
	if appeal.DecidedBy != 0 {
		t.Errorf("decided_by after erasure = %d, want 0", appeal.DecidedBy)
	}
	if appeal.DecidedByToken != token {
		t.Errorf("decided_by_token after erasure = %q, want %q kept", appeal.DecidedByToken, token)
	}
	if appeal.AssigneeID != 0 {
		t.Errorf("assignee_id after erasure = %d, want 0", appeal.AssigneeID)
	}
	if appeal.State != "upheld" || appeal.DecisionNote != "no" {
		t.Errorf("appeal after erasure = %+v, want the decision itself unchanged", appeal)
	}
}
