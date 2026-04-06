package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/store"
	"github.com/owncord/server/telemetry"
)

// UserService handles user profile and session operations.
type UserService struct {
	st store.Store
}

// NewUserService creates a UserService.
func NewUserService(st store.Store) *UserService {
	return &UserService{st: st}
}

// UpdateProfile updates a user's username and/or avatar.
// Returns the updated user for response building.
func (s *UserService) UpdateProfile(userID int64, username string, avatar *string) (*db.User, error) {
	ctx, span := telemetry.GlobalTracer("service/user").Start(context.Background(), "UserService.UpdateProfile",
		telemetry.Int64("user_id", userID),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationMs, start,
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
	_ = s.st.LogAudit(userID, "profile_update", "user", userID,
		fmt.Sprintf("username=%s", username))
	slog.Info("profile updated", "user_id", userID, "username", username)
	return user, nil
}

// ChangePassword verifies the old password hash matches, then updates.
// Returns the number of other sessions revoked.
func (s *UserService) ChangePassword(userID int64, newPasswordHash string, keepSessionID int64) (int64, error) {
	if err := s.st.UpdateUserPassword(userID, newPasswordHash); err != nil {
		return 0, fmt.Errorf("%w: failed to update password", ErrInternal)
	}
	revoked, err := s.st.DeleteOtherSessions(userID, keepSessionID)
	if err != nil {
		slog.Error("UserService.ChangePassword DeleteOtherSessions", "err", err, "user_id", userID)
	}
	_ = s.st.LogAudit(userID, "password_change", "user", userID, "password changed")
	slog.Info("password changed", "user_id", userID, "sessions_revoked", revoked)
	return revoked, nil
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
		return fmt.Errorf("%w: session not found", ErrNotFound)
	}
	_ = s.st.LogAudit(userID, "session_revoke", "session", sessionID, "session revoked")
	slog.Info("session revoked", "user_id", userID, "session_id", sessionID)
	return nil
}
