package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// reasonMaxRunes bounds the moderator-action ledger's free-text reason: 500 runes, no control characters. It
// applies to warning and timeout, whose reason is shown to the TARGET; the audit row never carries it (see
// Warn).
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

// requireHumanActor is the service-boundary absence-proof guard at the top of every ModerationService action:
// a non-positive actor id (plugin or automated caller) must never reach the ledger. Server/db's
// recordModerationAction/recordLedgerRow repeat it at the transaction. Deliberately not a schema CHECK:
// erasure sets actor_id to 0 for an erased moderator.
func requireHumanActor(actorID int64) error {
	if actorID <= 0 {
		return fmt.Errorf("%w: a moderation action requires a human actor", ErrForbidden)
	}
	return nil
}

// roleFor loads a principal's role through the permission cache. Every failure is Forbidden: an unresolvable
// role must never authorize a moderation action. which names the principal ("actor" or "target").
func (s *ModerationService) roleFor(ctx context.Context, userID int64, which string) (*db.Role, error) {
	if s.perms == nil {
		return nil, fmt.Errorf("%w: permission service unavailable", ErrForbidden)
	}
	role, err := s.perms.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		return nil, fmt.Errorf("%w: failed to load %s role", ErrForbidden, which)
	}
	return role.Effective(), nil
}

// requirePerm verifies the actor holds perm (or Administrator) and returns the actor's role. It runs before
// any target lookup, so an unauthorized actor sees Forbidden, never NotFound, and cannot enumerate user ids.
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

// requireOutranks enforces that the actor strictly outranks the target (so no moderating a peer or the
// owner). Runs after the permission and existence checks.
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
