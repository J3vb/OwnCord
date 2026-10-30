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
