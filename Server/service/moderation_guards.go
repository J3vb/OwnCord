package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// reasonMaxRunes bounds the moderator-action ledger's free-text reason (S6
// storage exhaustion, and the same shape the audit detail denylist expects
// of every free-text field): 500 runes, no control characters. Applies to
// warning and timeout, whose reason is shown to the TARGET — the audit row
// itself never carries it (a fixed phrase instead; see Warn).
const reasonMaxRunes = 500

// validateActionReason is warning/timeout's shared reason-shape rule.
func validateActionReason(reason string) error {
	if len([]rune(reason)) > reasonMaxRunes {
		return fmt.Errorf("%w: reason is too long", ErrBadRequest)
	}
	if hasControlChar(reason) {
		return fmt.Errorf("%w: reason contains control characters", ErrBadRequest)
	}
	return nil
}

// requireHumanActor is workstream 10's absence-proof guard, repeated at the
// top of every ModerationService action method before any other check: no
// plugin capability or automated caller can pass a non-positive actor id and
// have it land on the ledger (Server/db's recordModerationAction/
// recordLedgerRow repeat the same guard at the transaction, since that is
// the one place every kind funnels through — this is the service-boundary
// half). Deliberately NOT a schema CHECK (docs: erasure sets actor_id to 0
// for an erased moderator, and a constraint would forbid that transition).
func requireHumanActor(actorID int64) error {
	if actorID <= 0 {
		return fmt.Errorf("%w: a moderation action requires a human actor", ErrForbidden)
	}
	return nil
}

// roleFor loads a principal's role through the permission cache. Every failure is
// Forbidden: an unresolvable role must never authorize a moderation action.
// which names the principal in the error ("actor" or "target").
func (s *ModerationService) roleFor(ctx context.Context, userID int64, which string) (*db.Role, error) {
	if s.perms == nil {
		// Fail closed rather than allow unchecked actions.
		return nil, fmt.Errorf("%w: permission service unavailable", ErrForbidden)
	}
	role, err := s.perms.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		return nil, fmt.Errorf("%w: failed to load %s role", ErrForbidden, which)
	}
	return role.Effective(), nil
}

// requirePerm verifies the actor holds perm (or the Administrator bypass) and
// returns the actor's role. It takes no target and runs before any target lookup,
// so an unauthorized actor always sees Forbidden, never NotFound, and cannot
// enumerate user ids.
func (s *ModerationService) requirePerm(ctx context.Context, actorID, perm int64) (*db.Role, error) {
	actorRole, err := s.roleFor(ctx, actorID, "actor")
	if err != nil {
		return nil, err
	}
	if !permissions.HasServerPerm(actorRole.Permissions, perm) {
		return nil, fmt.Errorf("%w: missing %s permission", ErrForbidden, permissions.Name(perm))
	}
	return actorRole, nil
}

func (s *ModerationService) requireBanPermission(ctx context.Context, actorID int64) error {
	_, err := s.requirePerm(ctx, actorID, permissions.BanMembers)
	return err
}

// requireOutranks enforces that the actor strictly outranks the target so a user
// cannot moderate a peer or higher-ranked user (e.g. the owner). Runs after the
// permission and existence checks.
func (s *ModerationService) requireOutranks(ctx context.Context, actorID, targetID int64) error {
	actorRole, err := s.roleFor(ctx, actorID, "actor")
	if err != nil {
		return err
	}
	return s.requireOutranksRole(ctx, actorRole, targetID)
}

// requireOutranksRole is requireOutranks with the actor's role already loaded.
func (s *ModerationService) requireOutranksRole(ctx context.Context, actorRole *db.Role, targetID int64) error {
	targetRole, err := s.roleFor(ctx, targetID, "target")
	if err != nil {
		return err
	}
	if actorRole.Position <= targetRole.Position {
		return fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
	}
	return nil
}
