package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/telemetry"
)

// UserService handles user profile and session operations.
type UserService struct {
	st Store
}

// NewUserService creates a UserService.
func NewUserService(st Store) *UserService {
	return &UserService{st: st}
}

// UpdateProfile updates a user's username and/or avatar.
// Returns the updated user for response building.
func (s *UserService) UpdateProfile(ctx context.Context, userID int64, username string, avatar *string) (*db.User, error) {
	ctx, span := telemetry.GlobalTracer("service/user").Start(ctx, "UserService.UpdateProfile",
		telemetry.Int64("user_id", userID),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationSec, start,
			telemetry.String("method", "UpdateProfile"))
		span.End()
	}()

	if err := s.st.UpdateUserProfile(userID, username, avatar); err != nil {
		if db.IsUniqueConstraintError(err) {
			return nil, fmt.Errorf("%w: username is already taken", ErrConflict)
		}
		return nil, fmt.Errorf("%w: failed to update profile", ErrInternal)
	}
	user, err := s.st.GetUserByID(userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch updated user", ErrInternal)
	}
	db.WriteAudit(s.st, userID, "profile_update", "user", userID,
		fmt.Sprintf("username=%s", username))
	slog.Info("profile updated", "user_id", userID, "username", username)
	return user, nil
}

// ChangePasswordResult reports a completed password change. RevokeFailed is
// set when the password committed but other sessions could not be revoked —
// a partial success the caller must surface as a warning, never as a 5xx:
// the old password is already unusable, so telling the user the change
// "failed" walks them into retrying with a dead password and tripping the
// password-confirm lockout.
type ChangePasswordResult struct {
	SessionsRevoked int64
	RevokeFailed    bool
}

// ChangePassword updates the user's password and revokes other sessions.
func (s *UserService) ChangePassword(userID int64, newPasswordHash string, keepSessionID int64) (ChangePasswordResult, error) {
	if err := s.st.UpdateUserPassword(userID, newPasswordHash); err != nil {
		return ChangePasswordResult{}, fmt.Errorf("%w: failed to update password", ErrInternal)
	}

	// The password is committed from here on: every path below reports
	// success and writes the audit row.
	var res ChangePasswordResult
	revoked, err := s.st.DeleteOtherSessions(userID, keepSessionID)
	res.SessionsRevoked = revoked
	if err != nil {
		slog.Error("UserService.ChangePassword DeleteOtherSessions", "err", err, "user_id", userID)
		// One bounded compensating retry: revocation is the security tail of
		// the change and a single immediate retry covers transient write-lock
		// contention. ponytail: one retry, add backoff only if logs show it.
		if revokedRetry, retryErr := s.st.DeleteOtherSessions(userID, keepSessionID); retryErr == nil {
			res.SessionsRevoked += revokedRetry
		} else {
			res.RevokeFailed = true
		}
	}
	db.WriteAudit(s.st, userID, "password_change", "user", userID, "password changed")
	slog.Info("password changed", "user_id", userID,
		"sessions_revoked", res.SessionsRevoked, "revoke_failed", res.RevokeFailed)
	return res, nil
}

// ListSessions returns all active sessions for a user.
func (s *UserService) ListSessions(userID int64) ([]db.Session, error) {
	sessions, err := s.st.ListUserSessions(userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list sessions", ErrInternal)
	}
	return sessions, nil
}

// RevokeSession deletes a specific session owned by the user.
func (s *UserService) RevokeSession(userID, sessionID int64) error {
	if err := s.st.DeleteSessionByID(sessionID, userID); err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return fmt.Errorf("%w: session not found", ErrNotFound)
		}
		return fmt.Errorf("%w: failed to revoke session", ErrInternal)
	}
	db.WriteAudit(s.st, userID, "session_revoke", "session", sessionID, "session revoked")
	slog.Info("session revoked", "user_id", userID, "session_id", sessionID)
	return nil
}
