package service

import (
	"context"
	"errors"
	"fmt"
	"reflect"
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

// ── appealLocker (round 4, P2 review) ───────────────────────────────────

// TestAppealLocker_UnknownIDNeverCreatesAnEntry: Withdraw resolves ownership
// (resolveOwn) BEFORE acquiring the appeal's lock — an invented public id,
// reachable by any authenticated member calling withdraw in a loop without
// ever touching decision 8's submission quota, must never allocate a lock
// entry at all.
func TestAppealLocker_UnknownIDNeverCreatesAnEntry(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	for i := range 20 {
		if err := f.appeals.Withdraw(ctx, fixtureMember, fmt.Sprintf("invented-id-%d", i)); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Withdraw(invented id %d): want ErrNotFound, got %v", i, err)
		}
	}
	f.appeals.locks.mu.Lock()
	n := len(f.appeals.locks.locks)
	f.appeals.locks.mu.Unlock()
	if n != 0 {
		t.Fatalf("appealLocker has %d entries after %d invented-id withdraws, want 0", n, 20)
	}
}

// TestAppealLocker_EvictsAfterRealTransitionsFinish: a genuine transition on
// a REAL appeal must leave no trace in the lock map once it (and the lock's
// only other real holder) is done — reference-counted eviction, not an
// unbounded map, and never an LRU that could evict a lock still in use.
func TestAppealLocker_EvictsAfterRealTransitionsFinish(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	publicID := f.openAppeal(ctx, t)
	mustDo(t, "Assign", f.appeals.Assign(ctx, fixturePeerMod, publicID, false))
	mustDo(t, "Decide", f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "fine"))

	f.appeals.locks.mu.Lock()
	n := len(f.appeals.locks.locks)
	f.appeals.locks.mu.Unlock()
	if n != 0 {
		t.Fatalf("appealLocker has %d entries after every transition finished, want 0 (evicted)", n)
	}
}

// ── Authority wiring (round 4 test-strengthening item 2) ────────────────

// authCallbackRecorderStore wraps a real *db.DB (the established fake-store
// shape, e.g. errDMChannelIDsStore in message_perms_test.go) and records
// whether the checkAuthority argument DecideAppealTx receives is non-nil,
// then delegates to the real implementation unchanged.
type authCallbackRecorderStore struct {
	*db.DB
	sawNonNilCheckAuthority bool
}

func (r *authCallbackRecorderStore) DecideAppealTx(ctx context.Context, appealID int64, observedState string, observedAssigneeID int64, outcome string, decidedBy int64, note string,
	checkSelfReview bool, appellantID, permBit, adminBit int64, action db.AppealedAction,
	checkAuthority func(rolePerms int64, banned bool, banExpires *string) error,
) (db.AppealWriteOutcome, bool, bool, error) {
	r.sawNonNilCheckAuthority = checkAuthority != nil
	return r.DB.DecideAppealTx(ctx, appealID, observedState, observedAssigneeID, outcome, decidedBy, note, checkSelfReview, appellantID, permBit, adminBit, action, checkAuthority)
}

// noPrecheckStore wraps a real *db.DB but always reports "no existing
// appeal" from FindAppealForAction, disabling Submit's dedupe fast-path
// precheck (round 4 test-strengthening item 6) so a second Submit for the
// same action is forced past it and into the real UNIQUE(action_id)
// constraint InsertAppeal hits.
type noPrecheckStore struct {
	*db.DB
}

func (noPrecheckStore) FindAppealForAction(context.Context, int64) (int64, error) {
	return 0, nil
}

// TestAppeal_ServiceWiresANonNilAuthorityCallbackIntoDecideAppealTx proves
// s.checkModeratorAuthority actually reaches DecideAppealTx's checkAuthority
// parameter in PRODUCTION — not just that db/appeal_queries_test.go's own
// hook tests exercise a hand-supplied callback, which says nothing about
// what the service itself wires at the call site.
func TestAppeal_ServiceWiresANonNilAuthorityCallbackIntoDecideAppealTx(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	publicID := f.openAppeal(ctx, t)

	recorder := &authCallbackRecorderStore{DB: f.database}
	appeals := NewAppealService(recorder, f.mod.perms, f.mod, auth.NewRateLimiter())
	mustDo(t, "Decide", appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "no"))
	if !recorder.sawNonNilCheckAuthority {
		t.Fatal("AppealService.Decide called DecideAppealTx with a nil checkAuthority — the production service is not wiring its authority re-check")
	}
}

// ── Submission ───────────────────────────────────────────────────────────

func TestAppeal_OnlyTheTargetMaySubmit(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionID := f.warnMember(ctx, t, "be nice")

	if _, err := f.appeals.Submit(ctx, fixtureMember2, actionID, "not me"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("submit by a non-target: want ErrNotFound, got %v", err)
	}
	if _, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please reconsider"); err != nil {
		t.Fatalf("submit by the actual target: %v", err)
	}
}

// A moderator's own channel purge writes a removal row targeting
// themself. It is not a sanction, so it cannot be appealed.
func TestAppeal_SelfTargetedPurgeRowIsNotAppealable(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	mustCreateMessage(t, f.database, fixtureChannel, fixtureMember, "old", nil)
	if _, err := f.database.PurgeChannelMessagesWithAction(ctx, fixtureChannel, 0, 10, fixtureMod, nil); err != nil {
		t.Fatalf("PurgeChannelMessagesWithAction: %v", err)
	}
	rows := mustListModerationActionsForTarget(t, f.database, fixtureMod)
	var actionID int64
	for i := range rows {
		if r := &rows[i]; r.Kind == "removal" && r.ActorID == fixtureMod {
			actionID = r.ID
		}
	}
	if actionID == 0 {
		t.Fatal("purge wrote no self-targeted removal row")
	}

	if _, err := f.appeals.Submit(ctx, fixtureMod, actionID, "appeal my own purge"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("submit against own purge row: want ErrNotFound, got %v", err)
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

	actionID := f.warnMember(ctx, t, "be nice")

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
		actionID := f.warnMember(ctx, t, "x")
		if _, err := f.appeals.Submit(ctx, fixtureMember, actionID, "first"); err != nil {
			t.Fatalf("first submit: %v", err)
		}
		if _, err := f.appeals.Submit(ctx, fixtureMember, actionID, "second"); !errors.Is(err, ErrAlreadyAppealed) {
			t.Fatalf("second submit: want ErrAlreadyAppealed, got %v", err)
		}
	})

	t.Run("after decision", func(t *testing.T) {
		f := newAppealFixture(t)
		actionID := f.warnMember(ctx, t, "x")
		publicID := f.submitAppeal(ctx, t, actionID, "first")
		mustDo(t, "Decide", f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "no"))
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
		actionID := f.warnMember(ctx, t, "x")

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

	// "UNIQUE constraint alone" is round 4's test-strengthening ask: every
	// other subtest here goes through FindAppealForAction's own pre-check
	// first, so none of them actually prove Submit's db.ErrConflict ->
	// ErrAlreadyAppealed mapping (the InsertAppeal-side half of decision 8's
	// "one appeal per action, ever") — a broken mapping there would still
	// pass every subtest above, because the pre-check refuses first every
	// time. noPrecheckStore always reports "no existing appeal" from
	// FindAppealForAction, forcing the SECOND Submit past the pre-check and
	// into the real UNIQUE(action_id) constraint InsertAppeal hits.
	t.Run("UNIQUE constraint alone maps to ErrAlreadyAppealed with the pre-check disabled", func(t *testing.T) {
		f := newAppealFixture(t)
		actionID := f.warnMember(ctx, t, "x")
		if _, err := f.appeals.Submit(ctx, fixtureMember, actionID, "first"); err != nil {
			t.Fatalf("first submit: %v", err)
		}

		appeals := NewAppealService(noPrecheckStore{f.database}, f.mod.perms, f.mod, auth.NewRateLimiter())
		if _, err := appeals.Submit(ctx, fixtureMember, actionID, "second"); !errors.Is(err, ErrAlreadyAppealed) {
			t.Fatalf("second submit with the dedupe pre-check disabled: want ErrAlreadyAppealed (the UNIQUE(action_id) constraint's own db.ErrConflict must still map here), got %v", err)
		}
	})

	t.Run("after withdraw", func(t *testing.T) {
		f := newAppealFixture(t)
		actionID := f.warnMember(ctx, t, "x")
		publicID := f.submitAppeal(ctx, t, actionID, "first")
		mustDo(t, "Withdraw", f.appeals.Withdraw(ctx, fixtureMember, publicID))
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
		mustDo(t, "Warn", err)
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
	mustDo(t, "ForceLogoutWithAction", err)
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

	actionID := f.warnMember(ctx, t, "x")
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
	mustDo(t, "Warn", err)
	publicID, err := f.appeals.Submit(ctx, soleMemberID, actionID, "please")
	mustDo(t, "Submit", err)
	if err := f.appeals.Decide(ctx, soleModID, publicID, "upheld", "self-serving"); !errors.Is(err, ErrSelfReview) {
		t.Fatalf("acting moderator deciding their own appeal with an Administrator present: want ErrSelfReview, got %v", err)
	}
}

// ── State machine ────────────────────────────────────────────────────────

func TestAppeal_StateMachine(t *testing.T) {
	newOpen := func(t *testing.T, f *appealFixture) string {
		t.Helper()
		actionID, err := f.mod.Warn(context.Background(), fixtureMod, fixtureMember, "x", nil)
		mustDo(t, "Warn", err)
		publicID, err := f.appeals.Submit(context.Background(), fixtureMember, actionID, "please")
		mustDo(t, "Submit", err)
		return publicID
	}

	t.Run("open to assigned", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		mustDo(t, "Assign", f.appeals.Assign(context.Background(), fixturePeerMod, publicID, false))
	})

	t.Run("open directly to upheld", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		mustDo(t, "Decide", f.appeals.Decide(context.Background(), fixturePeerMod, publicID, "upheld", ""))
	})

	t.Run("open directly to overturned", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		mustDo(t, "Decide", f.appeals.Decide(context.Background(), fixturePeerMod, publicID, "overturned", ""))
	})

	t.Run("assigned to upheld", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		mustDo(t, "Assign", f.appeals.Assign(context.Background(), fixturePeerMod, publicID, false))
		mustDo(t, "Decide", f.appeals.Decide(context.Background(), fixturePeerMod, publicID, "upheld", ""))
	})

	t.Run("open to withdrawn by the appellant", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		mustDo(t, "Withdraw", f.appeals.Withdraw(context.Background(), fixtureMember, publicID))
	})

	t.Run("assigned to withdrawn by the appellant", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		mustDo(t, "Assign", f.appeals.Assign(context.Background(), fixturePeerMod, publicID, false))
		mustDo(t, "Withdraw", f.appeals.Withdraw(context.Background(), fixtureMember, publicID))
	})

	t.Run("nothing leaves upheld", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := newOpen(t, f)
		mustDo(t, "Decide", f.appeals.Decide(context.Background(), fixturePeerMod, publicID, "upheld", ""))
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
		mustDo(t, "Withdraw", f.appeals.Withdraw(context.Background(), fixtureMember, publicID))
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

	publicID := f.openAppeal(ctx, t)

	if err := f.appeals.Withdraw(ctx, fixturePeerMod, publicID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("withdraw by a moderator: want ErrNotFound, got %v", err)
	}
	if err := f.appeals.Withdraw(ctx, fixtureMember2, publicID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("withdraw by another member: want ErrNotFound, got %v", err)
	}
	mustDo(t, "withdraw by the appellant", f.appeals.Withdraw(ctx, fixtureMember, publicID))
}

// ── The deciding-moderator rule ──────────────────────────────────────────

func TestAppeal_ActingModeratorMayNotDecideWhereAnotherExists(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	// fixtureMod acted; fixturePeerMod is a second eligible moderator
	// (moderationActionsFixture grants both ModerateMembers).
	publicID := f.openAppeal(ctx, t)

	if err := f.appeals.Decide(ctx, fixtureMod, publicID, "upheld", "self-serving"); !errors.Is(err, ErrSelfReview) {
		t.Fatalf("acting moderator deciding their own appeal: want ErrSelfReview, got %v", err)
	}
	// The other eligible moderator may decide it.
	mustDo(t, "Decide by the other moderator", f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "fine"))
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
	mustDo(t, "Warn", err)
	publicID, err := f.appeals.Submit(ctx, fixturePeerMod, actionID, "please")
	mustDo(t, "Submit", err)

	if err := f.appeals.Assign(ctx, fixturePeerMod, publicID, false); !errors.Is(err, ErrSelfReview) {
		t.Fatalf("appellant assigning their own appeal: want ErrSelfReview, got %v", err)
	}
	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "self-approved"); !errors.Is(err, ErrSelfReview) {
		t.Fatalf("appellant deciding their own appeal: want ErrSelfReview, got %v", err)
	}
	// An uninvolved moderator may still decide it.
	mustDo(t, "Decide by an uninvolved moderator", f.appeals.Decide(ctx, fixtureMod, publicID, "upheld", "fine"))
}

// TestAppeal_ActingModeratorMayNotAssignWhereAnotherExists is Claim 6: the
// symmetric rule to TestAppeal_ActingModeratorMayNotDecideWhereAnotherExists
// applied to Assign instead of Decide — the moderator who took the
// appealed action may not assign it to themself either, where another
// eligible reviewer exists.
func TestAppeal_ActingModeratorMayNotAssignWhereAnotherExists(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	publicID := f.openAppeal(ctx, t)

	if err := f.appeals.Assign(ctx, fixtureMod, publicID, false); !errors.Is(err, ErrSelfReview) {
		t.Fatalf("acting moderator assigning their own appealed action to themself: want ErrSelfReview, got %v", err)
	}
	// The other eligible moderator may still assign it.
	mustDo(t, "Assign by the other moderator", f.appeals.Assign(ctx, fixturePeerMod, publicID, false))
}

func TestAppeal_SoleModeratorMayDecideAndAuditSaysSo(t *testing.T) {
	f := newSoleModeratorAppealFixture(t)
	ctx := context.Background()

	actionID, err := f.mod.Warn(ctx, soleModID, soleMemberID, "x", nil)
	mustDo(t, "Warn", err)
	publicID, err := f.appeals.Submit(ctx, soleMemberID, actionID, "please")
	mustDo(t, "Submit", err)

	rec := audittest.Install(t, f.database)
	mustDo(t, "sole moderator deciding their own appeal", f.appeals.Decide(ctx, soleModID, publicID, "upheld", "only mod here"))
	entry := rec.Wait(t, "appeal_decide")
	if !strings.Contains(entry.Detail, "sole moderator") {
		t.Fatalf("appeal_decide audit detail = %q, want it to name \"sole moderator\"", entry.Detail)
	}
}

func TestAppeal_UpholdChangesNothing(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	result, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil)
	mustDo(t, "Timeout", err)
	publicID, err := f.appeals.Submit(ctx, fixtureMember, result.ID, "please")
	mustDo(t, "Submit", err)
	mustDo(t, "Decide", f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "no"))
	active := mustHaveActiveTimeout(t, f.database, fixtureMember)
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
	mustDo(t, "Warn", err)
	publicID, err := f.appeals.Submit(ctx, fixturePeerMod, actionID, "please")
	mustDo(t, "Submit", err)

	rows, err := f.appeals.Queue(ctx, fixturePeerMod, "")
	mustDo(t, "Queue", err)
	for _, r := range rows {
		if r.PublicID == publicID {
			t.Fatalf("Queue for the appellant themself included their own appeal %q", publicID)
		}
	}
	// An uninvolved moderator sees it.
	rows, err = f.appeals.Queue(ctx, fixtureMod, "")
	mustDo(t, "Queue by an uninvolved moderator", err)
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
	mustDo(t, "Warn", err)
	publicID, err := f.appeals.Submit(ctx, fixturePeerMod, actionID, "please")
	mustDo(t, "Submit", err)

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

	publicID := f.openAppeal(ctx, t)

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

	publicID := f.openAppeal(ctx, t)
	mustDo(t, "Assign", f.appeals.Assign(ctx, fixturePeerMod, publicID, false))
	mustDo(t, "Decide", f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "no"))

	const token = "erased-mod-token"
	if _, err := f.database.EraseAccount(ctx, fixturePeerMod, token); err != nil {
		t.Fatalf("EraseAccount(deciding moderator): %v", err)
	}

	appeal, err := f.database.GetAppealByPublicID(ctx, publicID)
	mustDo(t, "GetAppealByPublicID after erasure", err)
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

// assignAfterInsertStore runs Assign in a goroutine right after the real
// InsertAppeal commits and waits briefly for it, simulating a moderator
// polling the queue between Submit's insert and its "open" broadcast.
type assignAfterInsertStore struct {
	Store
	appeals *AppealService
	actor   int64
}

func (s *assignAfterInsertStore) InsertAppeal(ctx context.Context, publicID string, actionID, appellantID int64, body string) (int64, error) {
	id, err := s.Store.InsertAppeal(ctx, publicID, actionID, appellantID, body)
	if err != nil {
		return id, err
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = s.appeals.Assign(ctx, s.actor, publicID, false)
	}()
	select {
	case <-done:
	case <-time.After(200 * time.Millisecond):
	}
	return id, nil
}

// TestSubmit_OpenBroadcastPrecedesConcurrentAssign: the appeal's lock must be
// held across Submit's insert, so a moderator who assigns the fresh row
// immediately cannot broadcast "assigned" before Submit's "open".
func TestSubmit_OpenBroadcastPrecedesConcurrentAssign(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionID := f.warnMember(ctx, t, "x")

	rec := &appealOrderRecorder{}
	store := &assignAfterInsertStore{Store: f.database, actor: fixturePeerMod}
	appeals := NewAppealService(store, f.mod.perms, f.mod, auth.NewRateLimiter())
	store.appeals = appeals
	appeals.SetQueueBroadcaster(&orderedQueueBroadcaster{rec: rec})

	if _, err := appeals.Submit(ctx, fixtureMember, actionID, "please"); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	// Assign may still be parked on the appeal's lock; wait for it to drain.
	deadline := time.Now().Add(2 * time.Second)
	for len(rec.snapshot()) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	want := []string{"queue:open", "queue:assigned"}
	if got := rec.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("broadcast order = %v, want %v", got, want)
	}
}

// failingDecideStore makes DecideAppealTx return a fixed outcome and error.
type failingDecideStore struct {
	*db.DB
	result db.AppealWriteOutcome
	err    error
}

func (s *failingDecideStore) DecideAppealTx(context.Context, int64, string, int64, string, int64, string,
	bool, int64, int64, int64, db.AppealedAction, func(int64, bool, *string) error,
) (db.AppealWriteOutcome, bool, bool, error) {
	return s.result, false, false, s.err
}

func decideWithStore(t *testing.T, st *failingDecideStore) error {
	t.Helper()
	f := newAppealFixture(t)
	ctx := context.Background()
	publicID := f.openAppeal(ctx, t)
	st.DB = f.database
	appeals := NewAppealService(st, f.mod.perms, f.mod, auth.NewRateLimiter())
	return appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "no")
}

// A database error while deciding is a server error, not "already decided".
func TestAppeal_DecideDatabaseErrorIsInternal(t *testing.T) {
	err := decideWithStore(t, &failingDecideStore{result: db.AppealWriteConflict, err: errors.New("disk I/O error")})
	if !errors.Is(err, ErrInternal) || errors.Is(err, ErrConflict) {
		t.Fatalf("Decide with a failing transaction: want ErrInternal and not ErrConflict, got %v", err)
	}
}

// A failed reversal still reports its own conflict, with the transaction error attached.
func TestAppeal_DecideReversalFailureStaysAConflict(t *testing.T) {
	err := decideWithStore(t, &failingDecideStore{result: db.AppealWriteReversalFailed, err: errors.New("reversal broke")})
	if !errors.Is(err, ErrReversalFailed) {
		t.Fatalf("Decide with a failed reversal: want ErrReversalFailed, got %v", err)
	}
}
