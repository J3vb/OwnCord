package service

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// requireRecoveryTargetBelow is the rank rule for an ISSUE_RECOVERY holder
// (WP 8.4d): unless the actor's top role is the owner's, the target's top role
// must sit strictly below it, and the owner is never a target. The owner has no
// such limit. The target may not hold an owner-tier bit the actor lacks. A target with no role is refused, failing closed.
func (s *AuthService) requireRecoveryTargetBelow(ctx context.Context, actor *db.MemberRoles, targetID int64) error {
	actorTop := actor.Top
	if permissions.IsOwner(actorTop.ID, actorTop.Position) {
		return nil
	}
	held, err := s.st.GetMemberRoles(ctx, targetID)
	if err != nil {
		slog.Error("recovery assist: GetMemberRoles (target) failed", "err", err, "user_id", targetID)
		return ErrRecoveryAssistFailed
	}
	if held == nil || permissions.IsOwner(held.Top.ID, held.Top.Position) || held.Top.Position >= actorTop.Position {
		return ErrRecoveryAssistRank
	}
	// A credential for an account carrying an owner-tier power the actor lacks
	// would be a way to take that power, so it is refused too.
	if held.Perms&permissions.OwnerOnlyGrant&^actor.Perms != 0 {
		return ErrRecoveryAssistRank
	}
	return nil
}
