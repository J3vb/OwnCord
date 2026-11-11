package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

type userSessionStore interface {
	db.Auditor
	ListUserSessions(ctx context.Context, userID int64) ([]db.Session, error)
	MarkSessionsSeen(ctx context.Context, userID, exceptSessionID int64) (int64, error)
	DeleteSessionByID(ctx context.Context, sessionID, userID int64) error
	SignOutEverywhere(ctx context.Context, userID int64) (sessions, tokens int64, err error)
}

type userSessions struct {
	st userSessionStore
}

// ListSessions returns all active sessions for a user.
func (s *userSessions) ListSessions(ctx context.Context, userID int64) ([]db.Session, error) {
	sessions, err := s.st.ListUserSessions(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list sessions: %w", ErrInternal, err)
	}
	return sessions, nil
}

// MarkSessionsSeen acknowledges the account's unseen logins: every other session's flag clears, the caller's
// own stays so the new device never acknowledges itself. A callerSessionID of 0 acknowledges all. No audit
// row.
func (s *userSessions) MarkSessionsSeen(ctx context.Context, userID, callerSessionID int64) error {
	if _, err := s.st.MarkSessionsSeen(ctx, userID, callerSessionID); err != nil {
		return fmt.Errorf("%w: failed to acknowledge sessions: %w", ErrInternal, err)
	}
	return nil
}

// RevokeSession deletes a specific session owned by the user.
func (s *userSessions) RevokeSession(ctx context.Context, userID, sessionID int64) error {
	if err := s.st.DeleteSessionByID(ctx, sessionID, userID); err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return fmt.Errorf("%w: session not found", ErrNotFound)
		}
		return fmt.Errorf("%w: failed to revoke session: %w", ErrInternal, err)
	}
	// Audit rows must survive a request canceled after the commit.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "session_revoke", "session", sessionID, "session revoked")
	slog.Info("session revoked", "user_id", userID, "session_id", sessionID)
	return nil
}

// RevokeAllSessions is sign-out-everywhere: every session, the caller's included, and every API token, so a
// stolen credential stops working now. Returns the sessions revoked.
func (s *userSessions) RevokeAllSessions(ctx context.Context, userID int64) (int64, error) {
	n, tokens, err := s.st.SignOutEverywhere(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("%w: failed to revoke sessions: %w", ErrInternal, err)
	}
	if n == 0 && tokens == 0 {
		slog.Debug("sign-out-everywhere found nothing to revoke", "user_id", userID)
		return 0, nil
	}
	// Audit rows must survive a request canceled after the commit; the row names the account and counts, never a
	// token or device.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "session_revoke_all", "user", userID,
		fmt.Sprintf("signed out everywhere (%d sessions, %d API tokens revoked)", n, tokens))
	slog.Info("all sessions revoked", "user_id", userID, "sessions_revoked", n, "api_tokens_revoked", tokens)
	return n, nil
}
