package admin

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/dbtime"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

const (
	// maxDeleteMessageSeconds is the longest history window a ban may delete:
	// seven days.
	maxDeleteMessageSeconds = 7 * 24 * 60 * 60
	// banPurgeBudget bounds the message deletion that follows a ban. Past it
	// the response reports purge.complete=false and the same request can be
	// repeated to continue.
	banPurgeBudget = 20 * time.Second
	// banRetryExpirySlack is how far a requested temporary-ban expiry may sit
	// past the stored one before the request counts as changing the ban. A
	// repeated request computes its expiry from a later "now".
	banRetryExpirySlack = time.Hour
)

// banPurgeOutcome is the "purge" object of a PATCH response.
type banPurgeOutcome struct {
	Deleted  int  `json:"deleted"`
	Complete bool `json:"complete"`
}

// patchUserPurgeResponse is the PATCH response when delete_message_seconds
// was above zero: the user object plus the purge outcome.
type patchUserPurgeResponse struct {
	adminUserResponse
	Purge *banPurgeOutcome `json:"purge"`
}

// patchUserValidatePurge checks delete_message_seconds before anything is
// changed and returns its value (0 when absent). The value must lie in
// 0..604800, and a non-zero value is accepted only together with banned=true.
// On false it has already written the 400.
func patchUserValidatePurge(w http.ResponseWriter, req patchUserRequest) (int, bool) {
	if req.DeleteMessageSeconds == nil {
		return 0, true
	}
	secs := *req.DeleteMessageSeconds
	if secs < 0 || secs > maxDeleteMessageSeconds {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "delete_message_seconds must be between 0 and 604800")
		return 0, false
	}
	if secs != 0 && (req.Banned == nil || !*req.Banned) {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "delete_message_seconds requires banned to be true")
		return 0, false
	}
	return secs, true
}

// patchUserValidateBan checks the ban fields of a PATCH (ban_duration_hours
// and, for a ban, the reason) before anything is changed or any rate-limit
// token is spent, and returns the temporary ban's expiry (nil = permanent or
// no ban). On false it has already written the 400.
func patchUserValidateBan(w http.ResponseWriter, req patchUserRequest) (*time.Time, bool) {
	if req.Banned == nil {
		return nil, true
	}
	var banExpires *time.Time
	if req.BanDurationHours != nil && *req.BanDurationHours != 0 {
		hours := *req.BanDurationHours
		if hours < 0 || hours > maxBanDurationHours {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "ban_duration_hours must be between 1 and 8760")
			return nil, false
		}
		t := time.Now().Add(time.Duration(hours) * time.Hour)
		banExpires = &t
	}
	if *req.Banned && req.BanReason != nil {
		if err := service.ValidateActionReason(*req.BanReason); err != nil {
			writeModerationErr(w, err)
			return nil, false
		}
	}
	return banExpires, true
}

// patchUserAuthorizePurge runs every precondition of deleting the target's
// recent messages along with the ban, without changing anything, so a refusal
// (403, or 429 from the per-actor rate limit) happens before the ban is
// written. On false it has already written the error response.
func patchUserAuthorizePurge(w http.ResponseWriter, r *http.Request, mod *service.ModerationService, actor, id int64) bool {
	if mod == nil {
		// Fail closed rather than ban without the purge's checks.
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "moderation service unavailable")
		return false
	}
	if err := mod.AuthorizeBanPurge(r.Context(), actor, id); err != nil {
		if errors.Is(err, service.ErrRateLimited) {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, err.Error())
			return false
		}
		writeModerationErr(w, err)
		return false
	}
	return true
}

// patchUserIsPurgeRetry reports whether the target is already banned and the
// request carries the same ban values, so it only adds the message deletion
// (a repeat of a purge that came back incomplete). The ban write is then
// skipped: no second ledger row and no refreshed reason or expiry. Any doubt
// (a failed read, an invalid duration) answers false and the ban is written
// as usual.
func patchUserIsPurgeRetry(r *http.Request, users *service.UserService, id int64, req patchUserRequest) bool {
	if req.Banned == nil || !*req.Banned {
		return false
	}
	target, err := users.Get(r.Context(), id)
	if err != nil || !auth.IsEffectivelyBanned(target) {
		return false
	}
	wantReason := ""
	if req.BanReason != nil {
		wantReason = *req.BanReason
	}
	haveReason := ""
	if target.BanReason != nil {
		haveReason = *target.BanReason
	}
	if wantReason != haveReason {
		return false
	}
	hours := 0
	if req.BanDurationHours != nil {
		hours = *req.BanDurationHours
	}
	if hours < 0 || hours > maxBanDurationHours {
		return false
	}
	if hours == 0 {
		return target.BanExpires == nil
	}
	if target.BanExpires == nil {
		return false
	}
	have, ok := dbtime.Parse(*target.BanExpires)
	if !ok {
		return false
	}
	want := time.Now().Add(time.Duration(hours) * time.Hour)
	return !have.After(want) && want.Sub(have) <= banRetryExpirySlack
}

// patchUserPurge deletes the freshly banned target's messages from the last
// seconds seconds and broadcasts every committed batch, including those of a
// purge that stopped early. The purge outlives a client that hangs up (the
// ban already committed) but is bounded by banPurgeBudget. The outcome is
// partial when Complete is false; repeating the request continues it.
func patchUserPurge(r *http.Request, hub HubBroadcaster, mod *service.ModerationService, actor, id int64, seconds int) *banPurgeOutcome {
	pctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), banPurgeBudget)
	defer cancel()

	res := mod.PurgeAfterBan(pctx, actor, id, time.Duration(seconds)*time.Second)
	if hub != nil {
		for _, b := range res.Batches {
			hub.BroadcastChatBulkDeleted(b.ChannelID, b.MessageIDs)
		}
	}
	if res.Err != nil {
		slog.Warn("admin ban purge incomplete", "actor_id", actor, "target_id", id, "deleted", res.Deleted, "err", res.Err)
	}
	return &banPurgeOutcome{Deleted: res.Deleted, Complete: res.Complete && res.Err == nil}
}
