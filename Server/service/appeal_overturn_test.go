package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
	"github.com/J3vb/OwnCord/Server/permissions"
)

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
	mustDo(t, "Timeout", err)
	publicID, err := f.appeals.Submit(ctx, fixtureMember, result.ID, body)
	mustDo(t, "Submit", err)

	rec := audittest.Install(t, f.database)
	mustDo(t, "Decide", f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", note))

	decideEntry := rec.Wait(t, "appeal_decide")
	if decideEntry.ActorID != fixturePeerMod {
		t.Fatalf("appeal_decide actor = %d, want the human decider %d", decideEntry.ActorID, fixturePeerMod)
	}
	// round 4/5: "user_untimeout" is now FinalizeTimeoutLift's own audit
	// write (not a second, appeal-specific one — see Decide's comment on why
	// the generic reversal-audit block excludes "timeout"), so its detail is
	// the same fixed "timeout lifted" a moderator-initiated LiftTimeout
	// leaves, not the appeal's public id; the appeal_decide row above is
	// where the appeal's own identity lives.
	reversalEntry := rec.Wait(t, "user_untimeout")
	if reversalEntry.ActorID != 0 {
		t.Fatalf("user_untimeout actor = %d, want 0 (a mechanical consequence of the decision)", reversalEntry.ActorID)
	}
	if reversalEntry.Detail != "timeout lifted" {
		t.Fatalf("user_untimeout detail = %q, want %q (FinalizeTimeoutLift's own)", reversalEntry.Detail, "timeout lifted")
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
		mustDo(t, "Timeout", err)
		publicID, err := f.appeals.Submit(ctx, fixtureMember, result.ID, "please")
		mustDo(t, "Submit", err)
		mustDo(t, "Decide", f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"))
		active, err := f.database.HasActiveTimeout(ctx, fixtureMember)
		mustDo(t, "HasActiveTimeout", err)
		if active {
			t.Fatal("timeout still active after the appeal was overturned")
		}
	})

	t.Run("ban", func(t *testing.T) {
		f := newAppealFixture(t)
		mustDo(t, "BanUser", f.mod.BanUser(ctx, fixtureMod, fixtureMember, "spam", nil))
		rows, err := f.database.ListModerationActionsForTarget(ctx, fixtureMember)
		mustDo(t, "ListModerationActionsForTarget", err)
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
		publicID := f.submitAppeal(ctx, t, actionID, "please")
		mustDo(t, "Decide", f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"))
		target, err := f.database.GetUserByID(ctx, fixtureMember)
		mustDo(t, "GetUserByID", err)
		if target.Banned {
			t.Fatal("target still banned after the appeal was overturned")
		}
	})

	t.Run("warning", func(t *testing.T) {
		f := newAppealFixture(t)
		publicID := f.openAppeal(ctx, t)
		mustDo(t, "Decide", f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"))
		notices, err := f.database.ListUnacknowledgedWarnings(ctx, fixtureMember)
		mustDo(t, "ListUnacknowledgedWarnings", err)
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
	f.mod.SetVoiceMuter(&dbBackedVoiceMuter{database: f.database})
	notifier := &fakeModActionNotifier{}
	f.mod.SetNotifier(notifier)

	mustDo(t, "JoinVoiceChannel", f.database.JoinVoiceChannel(ctx, fixtureMember, fixtureChannel))
	olderResult, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "first", time.Hour, nil)
	mustDo(t, "Timeout (older)", err)
	newerResult, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "second", 2*time.Hour, nil)
	mustDo(t, "Timeout (newer)", err)
	if olderResult.ID == newerResult.ID {
		t.Fatal("the two Timeout calls returned the same action id")
	}
	state, err := f.database.GetVoiceState(ctx, fixtureMember)
	if err != nil || state == nil || !state.ServerMuted {
		t.Fatalf("test setup broken: want the target server-muted (owned by the newer timeout) before the appeal, got %+v, err=%v", state, err)
	}
	notifier.kinds = nil // discard Timeout's own two "timeout" issue frames.

	// The older timeout is already superseded (lifted) by the newer one —
	// appealing it anyway (the target may not know which of two attempts a
	// notice referred to) must not disturb the newer, still-active row, its
	// voice mute (still owned by the newer timeout), or send a stale
	// "lifted" frame — B5-10 round 4/5, FinalizeTimeoutLift's own staleness
	// check (HasActiveTimeout).
	publicID, err := f.appeals.Submit(ctx, fixtureMember, olderResult.ID, "please")
	mustDo(t, "Submit against the older (superseded) timeout", err)
	mustDo(t, "Decide", f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"))

	active := mustHaveActiveTimeout(t, f.database, fixtureMember)
	if !active {
		t.Fatal("the newer timeout is no longer active after overturning the OLDER, already-superseded one")
	}
	rows := mustListModerationActionsForTarget(t, f.database, fixtureMember)
	for i := range rows {
		if r := &rows[i]; r.ID == newerResult.ID && r.LiftedAt != nil {
			t.Fatalf("the newer timeout (action %d) was lifted by overturning a different action", newerResult.ID)
		}
	}
	state, err = f.database.GetVoiceState(ctx, fixtureMember)
	if err != nil || state == nil || !state.ServerMuted {
		t.Fatalf("target must still be server-muted — the newer timeout still owns the mute, got %+v, err=%v", state, err)
	}
	if len(notifier.kinds) != 0 {
		t.Fatalf("NotifyModAction calls after overturning the superseded timeout = %v, want none — the newer timeout's own issue already published the current state", notifier.kinds)
	}
}

// TestAppeal_OverturnedTimeoutLiftsVoiceMuteWhenItApplied is B5-10 round
// 4/5's voice-reconcile wiring, the common case: the target is in voice
// when the timeout lands (the mute applies), and overturning the appeal
// against it — through Decide, not ModerationService.LiftTimeout — must
// still call FinalizeTimeoutLift and leave the target genuinely unmuted, the
// same as a moderator lifting it directly.
func TestAppeal_OverturnedTimeoutLiftsVoiceMuteWhenItApplied(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()
	f.mod.SetVoiceMuter(&dbBackedVoiceMuter{database: f.database})
	notifier := &fakeModActionNotifier{}
	f.mod.SetNotifier(notifier)

	mustDo(t, "JoinVoiceChannel", f.database.JoinVoiceChannel(ctx, fixtureMember, fixtureChannel))
	result, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil)
	mustDo(t, "Timeout", err)
	if result.VoiceSkipped {
		t.Fatal("test setup broken: want the voice half to apply")
	}
	state, err := f.database.GetVoiceState(ctx, fixtureMember)
	if err != nil || state == nil || !state.ServerMuted {
		t.Fatalf("test setup broken: want the target server-muted before the appeal, got %+v, err=%v", state, err)
	}
	notifier.kinds = nil // discard Timeout's own issue frame.

	publicID, err := f.appeals.Submit(ctx, fixtureMember, result.ID, "please")
	mustDo(t, "Submit", err)
	mustDo(t, "Decide", f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"))

	state, err = f.database.GetVoiceState(ctx, fixtureMember)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %+v, %v", state, err)
	}
	if state.ServerMuted {
		t.Fatal("target still server-muted after the appeal was overturned")
	}
	found := false
	for _, k := range notifier.kinds {
		if k == "timeout" {
			found = true
		}
	}
	if !found {
		t.Fatalf("NotifyModAction calls = %v, want a \"timeout\" (timeout-cleared) frame", notifier.kinds)
	}
}

// TestAppeal_OverturnedTimeoutWithNoVoiceHalfChangesNoVoiceState is B5-10
// round 4/5's voice-reconcile wiring, the other common case: the target was
// never in voice (the mute never applied, VoiceSkipped=true), so
// FinalizeTimeoutLift's own UnmuteForTimeout call has nothing to clear —
// overturning the appeal must not create or otherwise touch any voice
// state, though the ledger/notification side of the lift still applies.
func TestAppeal_OverturnedTimeoutWithNoVoiceHalfChangesNoVoiceState(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()
	f.mod.SetVoiceMuter(&dbBackedVoiceMuter{database: f.database})
	notifier := &fakeModActionNotifier{}
	f.mod.SetNotifier(notifier)

	result, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil)
	mustDo(t, "Timeout", err)
	if !result.VoiceSkipped {
		t.Fatal("test setup broken: want the voice half to be skipped (the target is not in voice)")
	}
	if state, err := f.database.GetVoiceState(ctx, fixtureMember); err != nil || state != nil {
		t.Fatalf("test setup broken: want no voice state for the target, got %+v, err=%v", state, err)
	}
	notifier.kinds = nil // discard Timeout's own issue frame.

	publicID, err := f.appeals.Submit(ctx, fixtureMember, result.ID, "please")
	mustDo(t, "Submit", err)
	mustDo(t, "Decide", f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"))

	if state, err := f.database.GetVoiceState(ctx, fixtureMember); err != nil || state != nil {
		t.Fatalf("voice state after overturning a never-applied timeout = %+v, err=%v, want still none", state, err)
	}
	found := false
	for _, k := range notifier.kinds {
		if k == "timeout" {
			found = true
		}
	}
	if !found {
		t.Fatalf("NotifyModAction calls = %v, want a \"timeout\" (timeout-cleared) frame even without a voice half", notifier.kinds)
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

	mustDo(t, "BanUser (first)", f.mod.BanUser(ctx, fixtureMod, fixtureMember, "first offense", nil))
	firstBanID := latestActionOfKind(t, ctx, f, fixtureMember, "ban")

	mustDo(t, "UnbanUser", f.mod.UnbanUser(ctx, fixtureMod, fixtureMember))
	mustDo(t, "BanUser (second)", f.mod.BanUser(ctx, fixtureMod, fixtureMember, "second offense", nil))
	secondBanID := latestActionOfKind(t, ctx, f, fixtureMember, "ban")
	if firstBanID == secondBanID {
		t.Fatal("the two BanUser calls returned the same action id")
	}

	// Appealing the FIRST ban, now superseded by the re-ban.
	publicID, err := f.appeals.Submit(ctx, fixtureMember, firstBanID, "please")
	mustDo(t, "Submit against the first ban", err)
	mustDo(t, "Decide", f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"))

	target := mustGetUserByID(t, f.database, fixtureMember)
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

	msgID := mustCreateMessage(t, f.database, fixtureChannel, fixtureMember2, "reported content", nil)
	result, err := f.mod.ActOnReport(ctx, ActOnReportParams{
		ActorID: fixtureMod, Kind: "removal", Reason: "linked removal", MessageID: msgID, ReportID: 999,
	})
	if err != nil {
		t.Fatalf("ActOnReport(removal): %v", err)
	}
	rows := mustListModerationActionsForTarget(t, f.database, fixtureMember2)
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
	mustDo(t, "Submit", err)
	mustDo(t, "Decide(removal, overturned)", f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"))
	appeal, err := f.database.GetAppealByPublicID(ctx, publicID)
	mustDo(t, "GetAppealByPublicID", err)
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
	mustDo(t, "ListModerationActionsForTarget", err)
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

// TestAppeal_OverturnRequiresOutrankAndKindPermission: overturning an appeal
// reverses the appealed action, so the decider must carry the same authority
// the direct reversal path does — outrank the target, and (for a ban) hold
// BAN_MEMBERS. Before this, any MODERATE_MEMBERS holder could overturn a
// timeout/warning a higher-ranked moderator issued, or clear a ban without
// BAN_MEMBERS, because Decide only checked CanModerate.
func TestAppeal_OverturnRequiresOutrankAndKindPermission(t *testing.T) {
	ctx := context.Background()

	t.Run("equal-rank target", func(t *testing.T) {
		f := newAppealFixture(t)

		// The owner (position 100) times out fixturePeerMod (position 80).
		// fixtureMod is that target's equal-rank peer (both position 80), so
		// it may not overturn the owner's action against it.
		result, err := f.mod.Timeout(ctx, fixtureOwner, fixturePeerMod, "cool off", time.Hour, nil)
		mustDo(t, "Timeout", err)
		publicID, err := f.appeals.Submit(ctx, fixturePeerMod, result.ID, "please")
		mustDo(t, "Submit", err)

		// Sanity: the direct lift path refuses this actor for the same
		// reason, so the assertion below is not accidentally vacuous.
		if err := f.mod.LiftTimeout(ctx, fixtureMod, fixturePeerMod); !errors.Is(err, ErrForbidden) {
			t.Fatalf("sanity: ModerationService.LiftTimeout(fixtureMod, fixturePeerMod): want ErrForbidden, got %v", err)
		}

		if err := f.appeals.Decide(ctx, fixtureMod, publicID, "overturned", "fine"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("Decide by an equal-rank peer: want ErrForbidden, got %v", err)
		}
		active, err := f.database.HasActiveTimeout(ctx, fixturePeerMod)
		mustDo(t, "HasActiveTimeout", err)
		if !active {
			t.Fatal("timeout was lifted despite the overturn being refused")
		}
		appeal, err := f.database.GetAppealByPublicID(ctx, publicID)
		mustDo(t, "GetAppealByPublicID", err)
		if appeal.State != "open" {
			t.Fatalf("appeal state = %q, want open (nothing may commit)", appeal.State)
		}
	})

	t.Run("ban without BAN_MEMBERS", func(t *testing.T) {
		f := newAppealFixture(t)

		// A moderator above the target (position 90, so it outranks
		// fixtureMember's 40) but holding only MODERATE_MEMBERS, never
		// BAN_MEMBERS.
		//nolint:contextcheck // seedRole/seedUser/seedUserRole always use context.Background() internally
		seedRole(t, f.database, &db.Role{ID: 6, Name: "warnmod", Permissions: permissions.ModerateMembers, Position: 90})
		const warnModID = int64(7)
		seedUser(t, f.database, &db.User{ID: warnModID, Username: "warnmod"}) //nolint:contextcheck // see above
		seedUserRole(t, f.database, warnModID, 6)                             //nolint:contextcheck // see above

		mustDo(t, "BanUser", f.mod.BanUser(ctx, fixtureMod, fixtureMember, "spam", nil))
		banID := latestActionOfKind(t, ctx, f, fixtureMember, "ban")
		publicID, err := f.appeals.Submit(ctx, fixtureMember, banID, "please")
		mustDo(t, "Submit", err)

		if err := f.appeals.Decide(ctx, warnModID, publicID, "overturned", "fine"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("Decide on a ban without BAN_MEMBERS: want ErrForbidden, got %v", err)
		}
		target, err := f.database.GetUserByID(ctx, fixtureMember)
		mustDo(t, "GetUserByID", err)
		if !target.Banned {
			t.Fatal("ban was lifted despite the overturn being refused")
		}
	})

	t.Run("outranking decider below the original actor may overturn", func(t *testing.T) {
		f := newAppealFixture(t)

		// The owner (100) issues the timeout; fixtureMod (80) outranks the
		// member target (40), so — exactly like the direct lift path — it may
		// overturn even though it does not outrank the original actor.
		result, err := f.mod.Timeout(ctx, fixtureOwner, fixtureMember, "cool off", time.Hour, nil)
		mustDo(t, "Timeout", err)
		publicID, err := f.appeals.Submit(ctx, fixtureMember, result.ID, "please")
		mustDo(t, "Submit", err)
		mustDo(t, "Decide by an outranking moderator", f.appeals.Decide(ctx, fixtureMod, publicID, "overturned", "fine"))
		active, err := f.database.HasActiveTimeout(ctx, fixtureMember)
		mustDo(t, "HasActiveTimeout", err)
		if active {
			t.Fatal("timeout still active after an outranking moderator overturned the appeal")
		}
	})
}
