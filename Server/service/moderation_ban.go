package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// BanUser bans a target user; the target must exist and not be the actor.
func (s *ModerationService) BanUser(ctx context.Context, actorID, targetID int64, reason string, expires *time.Time) error {
	return s.banUser(ctx, actorID, targetID, reason, expires, nil)
}

func (s *ModerationService) banUser(ctx context.Context, actorID, targetID int64, reason string, expires *time.Time, reportID *int64) error {
	ctx, done := traceCall(ctx, "service/moderation", "ModerationService.BanUser",
		telemetry.Int64("actor_id", actorID),
		telemetry.Int64("target_id", targetID),
	)
	defer done()

	if err := requireHumanActor(actorID); err != nil {
		return err
	}
	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return fmt.Errorf("%w: cannot ban yourself", ErrBadRequest)
	}
	if err := validateActionReason(reason); err != nil {
		return err
	}

	// Authorization before existence: an actor without ban authority learns nothing
	// about which user ids exist.
	if err := s.requireBanPermission(ctx, actorID); err != nil {
		return err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil || target.IsSystemAccount() {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranks(ctx, actorID, targetID); err != nil {
		return err
	}

	if _, err := s.st.BanUserWithAction(ctx, targetID, reason, expires, actorID, reportID); err != nil {
		if errors.Is(err, db.ErrOutranked) {
			return fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
		}
		return fmt.Errorf("%w: failed to ban user: %w", ErrInternal, err)
	}

	// Audit rows must survive a request canceled after the ban committed. The detail
	// is a fixed phrase, never the reason: the reason is already on users.ban_reason
	// for AdminPerimeter holders, and a second copy of free text could quote a message.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_ban", "user", targetID, "user banned")

	slog.Info("user banned", "actor_id", actorID, "target_id", targetID)
	return nil
}

// ForceLogout revokes every session of the target (the client's "Kick"; OwnCord is
// single-server so "remove from guild" has no referent). Gated on KICK_MEMBERS plus
// the ban hierarchy rule.
func (s *ModerationService) ForceLogout(ctx context.Context, actorID, targetID int64) error {
	return s.forceLogout(ctx, actorID, targetID, "", nil)
}

// forceLogout's reason is the ledger row's text; empty falls back to "all sessions
// terminated".
func (s *ModerationService) forceLogout(ctx context.Context, actorID, targetID int64, reason string, reportID *int64) error {
	if err := requireHumanActor(actorID); err != nil {
		return err
	}
	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return fmt.Errorf("%w: cannot force-logout yourself", ErrBadRequest)
	}
	if err := validateActionReason(reason); err != nil {
		return err
	}

	// Authorization before existence, see BanUser.
	actorRole, err := s.requirePerm(ctx, actorID, permissions.KickMembers)
	if err != nil {
		return err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil || target.IsSystemAccount() {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranksRole(ctx, actorRole, targetID); err != nil {
		return err
	}

	if _, err := s.st.ForceLogoutWithAction(ctx, targetID, actorID, reportID, reason); err != nil {
		if errors.Is(err, db.ErrOutranked) {
			return fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
		}
		return fmt.Errorf("%w: failed to log out user: %w", ErrInternal, err)
	}

	// The sessions are gone; drop the socket now rather than at the hub's 30-second
	// sweep (as profile_handler.go and recovery.go do), since kick exists for
	// immediate ejection. A notifier without this (tests, nil) is a no-op.
	if d, ok := s.notifier.(SessionDisconnector); ok {
		d.DisconnectRevokedUser(targetID)
	}

	// Audit rows must survive a request canceled after the commit. Fixed phrase,
	// never the reason, as in Ban's audit row.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "force_logout", "user", targetID,
		"all sessions terminated")

	slog.Info("force logout", "actor_id", actorID, "target_id", targetID)
	return nil
}

// UnbanUser removes a ban on a target user.
func (s *ModerationService) UnbanUser(ctx context.Context, actorID, targetID int64) error {
	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}

	// Authorization before existence, see BanUser.
	if err := s.requireBanPermission(ctx, actorID); err != nil {
		return err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil || target.IsSystemAccount() {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranks(ctx, actorID, targetID); err != nil {
		return err
	}

	if err := s.st.UnbanUser(ctx, targetID); err != nil {
		return fmt.Errorf("%w: failed to unban user: %w", ErrInternal, err)
	}

	// Audit rows must survive a request canceled after the commit.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_unban", "user", targetID, "")

	slog.Info("user unbanned", "actor_id", actorID, "target_id", targetID)
	return nil
}
