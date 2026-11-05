package service

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db"
)

// requireOverturnAuthority gates an OVERTURN by the authority the direct reversal
// path enforces: the decider must strictly outrank the sanctioned target (no
// moderator reverses a peer's or higher-ranked moderator's action) and hold the
// permission the original action needed; for a ban that is BAN_MEMBERS, mirroring
// UnbanUser, so a MODERATE_MEMBERS-only holder cannot reverse a ban. Warning and
// timeout need only MODERATE_MEMBERS (requireModerate). "removal" is excluded:
// overturning it is record-only, so no rank or MANAGE_MESSAGES gate applies.
// Upholding changes nothing and needs no gate.
// This is the CACHED pre-check. The rank check repeats live inside DecideAppealTx's
// transaction (as LiftTimeout does), so a decider demoted in between commits
// nothing.
func (s *AppealService) requireOverturnAuthority(ctx context.Context, actorID int64, action *db.ModerationAction) error {
	switch action.Kind {
	case "ban":
		if err := s.moderation.requireBanPermission(ctx, actorID); err != nil {
			return err
		}
	case "timeout", "warning":
	default:
		return nil
	}
	return s.moderation.requireOutranks(ctx, actorID, action.TargetID)
}

// applyOverturnReversalEffects runs Decide's post-commit, best-effort overturn
// consequences on a detached context (the decision already committed):
//
//   - the reversal audit row, actor 0 (a mechanical consequence, not a second
//     human action; the convention of LiftTimeoutByActionID's lifted_by=0),
//     naming the appeal. Written only when reversalApplied, since a
//     superseded/already-lifted action reverses to a no-op not worth auditing.
//     "timeout" is excluded: FinalizeTimeoutLift writes its own user_untimeout
//     row, so this generic write never runs twice for one event.
//   - the overturned timeout's voice reconcile via FinalizeTimeoutLift, called
//     unconditionally (not gated on reversalApplied) because that method does its
//     own staleness check: a newer timeout still gets its voice half repaired
//     (only what THIS action id owns) but is not announced or audited again.
//     actorID 0 since the human decider is already on the appeal_decide row.
func (s *AppealService) applyOverturnReversalEffects(ctx context.Context, appeal *db.Appeal, action *db.ModerationAction, outcome string, reversalApplied bool) {
	if reversalApplied {
		if auditAction, ok := db.ReversalAuditActionFor(action.Kind); ok && action.Kind != "timeout" {
			db.WriteAudit(context.WithoutCancel(ctx), s.st, 0, auditAction, "user", action.TargetID, "overturned appeal "+appeal.PublicID)
		}
		if action.Kind == "ban" {
			// The reversal actually lifted a live ban (reversalApplied is true only when
			// the guarded UPDATE changed a row). Clients hard-deleted the row on the ban's
			// member_ban, so re-add it as the admin unban path does, or they keep the user
			// missing until a full ready.
			s.broadcastUnban(action.TargetID)
		}
	}
	if outcome == "overturned" && action.Kind == "timeout" {
		s.moderation.FinalizeTimeoutLift(ctx, action.TargetID, []int64{action.ID}, 0)
	}
}
