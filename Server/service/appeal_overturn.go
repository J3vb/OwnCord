package service

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db"
)

// requireOverturnAuthority gates an OVERTURN by the same authority the direct
// reversal path enforces: the decider must strictly outrank the sanctioned
// target (no moderator may reverse a peer's or a higher-ranked moderator's
// action), and must hold the permission the original action needed — for a
// ban that is BAN_MEMBERS, mirroring UnbanUser, since a ban reversal must not
// be reachable by a MODERATE_MEMBERS-only holder. Warning and timeout need
// only MODERATE_MEMBERS, already checked by requireModerate. "removal" is
// excluded: overturning it is record-only (the content is already gone), so
// no authority beyond MODERATE_MEMBERS is needed and a rank or
// MANAGE_MESSAGES gate here would mirror nothing. Upholding changes nothing
// and needs no such gate.
//
// This is the CACHED pre-check half. The rank re-check is repeated live
// inside DecideAppealTx's own transaction (see its outrank re-read), the
// parity the direct LiftTimeout path already has (P2-8), so a decider
// demoted between this call and the decision commits nothing.
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
