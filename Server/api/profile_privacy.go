// profile_privacy.go — per-user direct message privacy (migration 070, WP 6.8b).
//
// Both routes key on the session user and there is no route that reads another
// user's settings. Sync across devices is by REST only, so nothing here is
// broadcast.

package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// privacyMaxBody bounds a privacy PUT body; the real body is under 100 bytes.
const privacyMaxBody = 1024

type privacyJSON struct {
	AllowMemberDMs  bool `json:"allow_member_dms"`
	MessageRequests bool `json:"message_requests"`
}

func handleGetPrivacy(privacy *service.PrivacyService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		p, err := privacy.Get(r.Context(), user.ID)
		if err != nil {
			slog.Error("get privacy", "error", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load privacy settings")
			return
		}
		writeJSON(w, http.StatusOK, privacyJSON{AllowMemberDMs: p.AllowMemberDMs, MessageRequests: p.MessageRequests})
	}
}

// evictUntrustedFromVoice removes, from each 1:1 DM voice call userID is in,
// the other participant when userID has just turned direct messages from
// members off and does not trust them: the same eviction a block performs
// (evictBlockedUserFromVoice), reached by the same hub capability. The setting
// is already stored when this runs, so a failure here is logged and the voice
// sweep removes the person on its next pass.
func evictUntrustedFromVoice(ctx context.Context, privacy *service.PrivacyService, broadcaster ProfileBroadcaster, userID int64) {
	ve, evictable := broadcaster.(dmVoiceEvictor)
	if !evictable {
		return
	}
	callers, err := privacy.UntrustedCallers(ctx, userID)
	if err != nil {
		slog.Warn("privacy: voice call lookup for eviction failed", "user_id", userID, "err", err)
		return
	}
	for _, c := range callers {
		ve.DisconnectFromVoiceInChannel(ctx, c.UserID, c.ChannelID, ws.VoiceLeaveReasonBlocked)
	}
}

func handlePutPrivacy(privacy *service.PrivacyService, broadcaster ProfileBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, privacyMaxBody)
		var in struct {
			AllowMemberDMs  *bool `json:"allow_member_dms"`
			MessageRequests *bool `json:"message_requests"`
		}
		if !decodeStrictJSON(w, r, &in) {
			return
		}
		if in.AllowMemberDMs == nil || in.MessageRequests == nil {
			writeErr(w, http.StatusBadRequest, "INVALID_INPUT", "invalid request body")
			return
		}
		p, err := privacy.Set(r.Context(), user.ID, service.Privacy{AllowMemberDMs: *in.AllowMemberDMs, MessageRequests: *in.MessageRequests})
		if err != nil {
			slog.Error("set privacy", "error", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not save privacy settings")
			return
		}
		if !p.AllowMemberDMs {
			evictUntrustedFromVoice(context.WithoutCancel(r.Context()), privacy, broadcaster, user.ID)
		}
		writeJSON(w, http.StatusOK, privacyJSON{AllowMemberDMs: p.AllowMemberDMs, MessageRequests: p.MessageRequests})
	}
}
