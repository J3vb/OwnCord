package service

import (
	"context"
	"log/slog"
)

// keepSessionID is the session a 2FA state change keeps alive. BUG-108: an
// API-token principal has a nil session; keep=0 matches no row, so every
// login session is revoked — same semantics as change-password.
func keepSessionID(p Principal) int64 {
	if p.Session != nil {
		return p.Session.ID
	}
	return 0
}

// revokeOtherSessionsAfterAuthChange revokes every session for userID except
// keepSessionID as the security tail of a committed 2FA state change. It
// mirrors UserService.ChangePassword (service/user.go:262-274): a failure is
// logged and retried once (bounded compensating retry for transient write
// contention); if the retry also fails, revoked reports what did succeed and
// failed is true so the caller can report a partial success instead of
// silently claiming the other sessions were revoked when they were not.
func (s *AuthService) revokeOtherSessionsAfterAuthChange(ctx context.Context, userID, keepSessionID int64, action string) (revoked int64, failed bool) {
	revoked, err := s.st.DeleteOtherSessions(ctx, userID, keepSessionID)
	if err != nil {
		slog.Error("DeleteOtherSessions after "+action, "err", err, "user_id", userID)
		revokedRetry, retryErr := s.st.DeleteOtherSessions(ctx, userID, keepSessionID)
		if retryErr != nil {
			slog.Error("DeleteOtherSessions retry after "+action, "err", retryErr, "user_id", userID)
			return revoked, true
		}
		revoked += revokedRetry
	}
	if revoked > 0 {
		slog.Info("revoked other sessions after "+action, "user_id", userID, "revoked", revoked)
		// Drop the account's socket now if it rode one of them, rather than
		// at the sweep's next tick; the kept session's socket stays.
		if d, ok := s.broadcaster.(SessionDisconnector); ok {
			d.DisconnectIfSessionRevoked(userID)
		}
	}
	return revoked, false
}
