package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

type changePasswordRequest struct {
	OldPassword string `json:"old_password"`
	NewPassword string `json:"new_password"`
	// Also revokes every API token of the account; absent means false, so an older client keeps its tokens.
	RevokeAPITokens bool `json:"revoke_api_tokens"`
}

type sessionResponse struct {
	ID        int64  `json:"id"`
	Device    string `json:"device"`
	IP        string `json:"ip"`
	CreatedAt string `json:"created_at"`
	LastUsed  string `json:"last_used"`
	IsCurrent bool   `json:"is_current"`
	// The new-login signal: true from the login that created the session until the account lists its sessions
	// from another device, which acknowledges every row but the caller's own.
	Unseen bool `json:"unseen"`
}

type sessionsListResponse struct {
	Sessions []sessionResponse `json:"sessions"`
}

// ownAPITokenResponse is one of the caller's live API tokens; never a hash or raw token (only the one shown
// at creation is usable).
type ownAPITokenResponse struct {
	ID        int64   `json:"id"`
	Label     string  `json:"label"`
	CreatedAt string  `json:"created_at"`
	LastUsed  *string `json:"last_used"`
	ExpiresAt *string `json:"expires_at"`
}

type ownAPITokensListResponse struct {
	Tokens []ownAPITokenResponse `json:"tokens"`
}

// revokeAllSessionsRateLimitPerMinute bounds DELETE /api/v1/users/me/sessions per account; each call
// revokes the caller's own session, so it bounds how fast a fresh sign-in can repeat it.
const revokeAllSessionsRateLimitPerMinute = 5

func handleChangePassword(svc *service.Services, limiter *auth.RateLimiter, broadcaster ProfileBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		// Per-user lockout against password brute-force via a stolen session.
		lockKey := auth.Key("pw_confirm_lock", user.ID)
		if limiter.IsLockedOut(lockKey) {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "too many failed attempts, try again later")
			return
		}

		var req changePasswordRequest
		if !decodeJSON(w, r, &req) {
			return
		}

		if req.OldPassword == "" || req.NewPassword == "" {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "old_password and new_password are required")
			return
		}

		// Verify the old password (constant-time bcrypt) inside the one admission slot every password route
		// takes: a refused attempt ran no compare and counts as no failure.
		failKey := auth.Key("pw_confirm_fail", user.ID)
		refund, reserved := service.ReservePasswordAttempt(limiter, failKey, service.PwConfirmFailureThreshold, service.PwConfirmFailureWindow)
		if !reserved {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "too many failed attempts, try again later")
			return
		}
		matched, admitted := limiter.Admission().CheckPassword(user.PasswordHash, req.OldPassword)
		if !admitted {
			refund()
			writeAuthBusy(w, service.ErrAuthBusy)
			return
		}
		if !matched {
			service.SettleFailedAttempt(r.Context(), limiter, failKey, lockKey, service.PwConfirmFailureThreshold, service.PwConfirmFailureWindow, service.PwConfirmLockoutDuration)
			writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "incorrect password")
			return
		}
		limiter.Reset(r.Context(), failKey)

		if req.OldPassword == req.NewPassword {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "new password must be different from old password")
			return
		}

		if err := auth.ValidatePasswordStrength(req.NewPassword); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, err.Error())
			return
		}

		hash, admitted, err := limiter.Admission().HashPassword(req.NewPassword)
		if !admitted {
			writeAuthBusy(w, service.ErrAuthBusy)
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to process password change")
			return
		}

		sess, _ := r.Context().Value(SessionKey).(*db.Session)
		keepSessionID := int64(0)
		if sess != nil {
			keepSessionID = sess.ID
		}

		res, err := svc.Users.ChangePassword(r.Context(), user.ID, hash, keepSessionID, req.RevokeAPITokens)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		// Drop the account's socket now if it rode a revoked session, rather than at the next sweep.
		if res.SessionsRevoked > 0 {
			disconnectIfSessionRevoked(broadcaster, user.ID)
		}
		if res.RevokeFailed {
			// Partial success: the password IS changed, and a 5xx would tell the user to retry with a
			// password that no longer works.
			writeJSON(w, http.StatusOK, map[string]any{
				"warning":            "password changed, but other sessions or API tokens could not be revoked; revoke them from the sessions list",
				"sessions_revoked":   res.SessionsRevoked,
				"api_tokens_revoked": res.TokensRevoked,
			})
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

func handleListSessions(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		// requireLoginSession guarantees a session; the nil check stays so the handler never dereferences one
		// it was not given.
		sess, _ := r.Context().Value(SessionKey).(*db.Session)

		sessions, err := svc.Users.ListSessions(r.Context(), user.ID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		resp := sessionsListResponse{
			Sessions: make([]sessionResponse, 0, len(sessions)),
		}
		ackPending := false
		for _, s := range sessions {
			if s.Unseen && (sess == nil || s.ID != sess.ID) {
				ackPending = true
			}
			resp.Sessions = append(resp.Sessions, sessionResponse{
				ID:        s.ID,
				Device:    s.Device,
				IP:        s.IP,
				CreatedAt: s.CreatedAt,
				LastUsed:  s.LastUsed,
				IsCurrent: sess != nil && s.ID == sess.ID,
				Unseen:    s.Unseen,
			})
		}

		// Listing acknowledges the response's flags except for the caller's own session; with nothing to
		// acknowledge the GET stays a pure read and never takes the writer.
		if ackPending {
			var callerSessionID int64
			if sess != nil {
				callerSessionID = sess.ID
			}
			if err := svc.Users.MarkSessionsSeen(r.Context(), user.ID, callerSessionID); err != nil {
				// A failed "seen" write must not discard a built list: return it and log rather than 500.
				slog.WarnContext(r.Context(), "list sessions: failed to mark seen", "err", err)
			}
		}

		writeJSON(w, http.StatusOK, resp)
	}
}

func handleRevokeSession(svc *service.Services, broadcaster ProfileBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		sessionID, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}

		if err := svc.Users.RevokeSession(r.Context(), user.ID, sessionID); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		disconnectIfSessionRevoked(broadcaster, user.ID)

		w.WriteHeader(http.StatusNoContent)
	}
}

// handleListOwnAPITokens lists the caller's live API tokens, every credential that acts as them besides
// sessions.
func handleListOwnAPITokens(tokens *service.TokenService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		items, err := tokens.ListMine(r.Context(), user.ID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		resp := ownAPITokensListResponse{Tokens: make([]ownAPITokenResponse, 0, len(items))}
		for _, it := range items {
			resp.Tokens = append(resp.Tokens, ownAPITokenResponse{
				ID:        it.ID,
				Label:     it.Label,
				CreatedAt: it.CreatedAt,
				LastUsed:  it.LastUsed,
				ExpiresAt: it.ExpiresAt,
			})
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// handleRevokeOwnAPIToken revokes one of the caller's API tokens; any other id is 404.
func handleRevokeOwnAPIToken(tokens *service.TokenService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		id, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}
		if err := tokens.RevokeMine(r.Context(), user.ID, id); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// revokeAllSessionsResponse carries the count and a note that the caller's own session was among them, so
// the client re-authenticates instead of treating the next 401 as an error.
type revokeAllSessionsResponse struct {
	SessionsRevoked int64 `json:"sessions_revoked"`
	CurrentRevoked  bool  `json:"current_session_revoked"`
}

// handleRevokeAllSessions is sign-out-everywhere: the current session, every API token and every live
// WebSocket are revoked.
func handleRevokeAllSessions(svc *service.Services, limiter *auth.RateLimiter, broadcaster ProfileBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		sess, _ := r.Context().Value(SessionKey).(*db.Session)

		if !limiter.Allow(auth.Key("revoke_all", user.ID), revokeAllSessionsRateLimitPerMinute, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "too many sign-out-everywhere requests, try again later")
			return
		}

		n, err := svc.Users.RevokeAllSessions(r.Context(), user.ID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		// Drop the sockets now so "stops working immediately" holds for a connected device.
		if n > 0 {
			if d, ok := broadcaster.(SessionDisconnector); ok {
				d.DisconnectRevokedUser(user.ID)
			}
		}
		// requireLoginSession guarantees sess; the check keeps the handler from claiming a revoke it was not
		// given.
		writeJSON(w, http.StatusOK, revokeAllSessionsResponse{
			SessionsRevoked: n,
			CurrentRevoked:  sess != nil,
		})
	}
}
