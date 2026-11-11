package service

import (
	"context"
	"log/slog"
)

func keepSessionID(p Principal) int64 {
	if p.Session != nil {
		return p.Session.ID
	}
	return 0
}

// revokeOtherSessionsAfterAuthChange revokes every session but keepSessionID after a
// committed 2FA change, as UserService.ChangePassword does: retried once on failure; then
// failed is true and revoked reports what succeeded, so the caller reports partial success.
func (s *twoFactor) revokeOtherSessionsAfterAuthChange(ctx context.Context, userID, keepSessionID int64, action string) (revoked int64, failed bool) {
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
		if d, ok := s.broadcaster.(SessionDisconnector); ok {
			d.DisconnectIfSessionRevoked(userID)
		}
	}
	return revoked, false
}
