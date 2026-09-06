package service

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
	"github.com/J3vb/OwnCord/Server/permissions"
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

	actionID, err := f.database.ForceLogoutWithAction(ctx, fixtureMember, fixtureMod, nil)
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
	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "no"); err != nil {
		t.Fatalf("Decide: %v", err)
	}

	if _, err := f.database.EraseAccount(ctx, fixturePeerMod, ""); err != nil {
		t.Fatalf("EraseAccount(deciding moderator): %v", err)
	}

	appeal, err := f.database.GetAppealByPublicID(ctx, publicID)
	if err != nil {
		t.Fatalf("GetAppealByPublicID after erasure: %v", err)
	}
	if appeal.DecidedBy != 0 {
		t.Errorf("decided_by after erasure = %d, want 0", appeal.DecidedBy)
	}
	if appeal.State != "upheld" || appeal.DecisionNote != "no" {
		t.Errorf("appeal after erasure = %+v, want the decision itself unchanged", appeal)
	}
}
