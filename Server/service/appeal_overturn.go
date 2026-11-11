package service

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db"
)

// requireOverturnAuthority gates an OVERTURN like the direct reversal path: the decider
// must strictly outrank the target and hold the permission the original action needed
// (BAN_MEMBERS for a ban, as UnbanUser; MODERATE_MEMBERS for warning and timeout).
// "removal" is record-only, so no gate; upholding needs none. This is the cached
// pre-check; the rank check repeats inside DecideAppealTx's transaction.
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

// applyOverturnReversalEffects runs Decide's best-effort post-commit overturn effects on
// a detached context: the reversal audit row (actor 0; not for "timeout", where
// FinalizeTimeoutLift writes its own row), and the timeout's voice reconcile via
// FinalizeTimeoutLift, called unconditionally because it does its own staleness check.
func (s *AppealService) applyOverturnReversalEffects(ctx context.Context, appeal *db.Appeal, action *db.ModerationAction, outcome string, reversalApplied bool) {
	if reversalApplied {
		if auditAction, ok := db.ReversalAuditActionFor(action.Kind); ok && action.Kind != "timeout" {
			db.WriteAudit(context.WithoutCancel(ctx), s.st, 0, auditAction, "user", action.TargetID, "overturned appeal "+appeal.PublicID)
		}
		if action.Kind == "ban" {
			// The reversal lifted a live ban. Clients hard-deleted the row on member_ban, so re-add
			// it as the admin unban path does.
			s.broadcastUnban(action.TargetID)
		}
	}
	if outcome == "overturned" && action.Kind == "timeout" {
		s.moderation.FinalizeTimeoutLift(ctx, action.TargetID, []int64{action.ID}, 0)
	}
}
