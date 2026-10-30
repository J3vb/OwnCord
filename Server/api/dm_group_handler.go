package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// Group DM membership routes: add, remove and owner transfer. The
// leave and rename routes live in dm_handler.go and share the fan-out below.

// dmGroupRateLimitPerMinute bounds, per user, the group mutations that publish
// to other members (add, remove, owner transfer, rename).
const dmGroupRateLimitPerMinute = 20

const dmGroupMaxBody = 1 << 14

// groupEventSink is the DMBroadcaster capability that delivers group system rows
// as sequenced chat_message frames. Reached by type assertion so SendToUser-only
// test doubles keep working; the production broadcaster must keep satisfying it
// or the rows silently stop going out.
type groupEventSink interface {
	GroupEventRows(ctx context.Context, channelID int64, audience []int64, rows []service.GroupEventRow)
}

var _ groupEventSink = (*ws.Hub)(nil)

// dmVoiceRosterSender is the DMBroadcaster capability that tells one user who is
// in a DM's call now. Reached by type assertion like groupEventSink; the
// production broadcaster must keep satisfying it or a member added mid-call
// stops seeing the roster.
type dmVoiceRosterSender interface {
	SendDMVoiceRoster(ctx context.Context, userID, channelID int64)
}

var _ dmVoiceRosterSender = (*ws.Hub)(nil)

// sendAddedVoiceRoster hands each newly added member the group call's current
// voice states. It runs after fanOutGroupChange so the user's dm_channel_open
// precedes the first state on each connection.
func sendAddedVoiceRoster(ctx context.Context, broadcaster DMBroadcaster, channelID int64, added []int64) {
	if broadcaster == nil || len(added) == 0 {
		return
	}
	rs, ok := broadcaster.(dmVoiceRosterSender)
	if !ok {
		return
	}
	ctx = context.WithoutCancel(ctx)
	for _, uid := range added {
		rs.SendDMVoiceRoster(ctx, uid, channelID)
	}
}

type addGroupMembersRequest struct {
	UserIDs []int64 `json:"user_ids"`
}

type transferGroupOwnerRequest struct {
	UserID int64 `json:"user_id"`
}

// allowGroupMutation applies the per-user limit and writes the 429 itself; a nil
// limiter allows.
func allowGroupMutation(w http.ResponseWriter, limiter *auth.RateLimiter, userID int64) bool {
	if limiter == nil || limiter.Allow(auth.Key("dm_group", userID), dmGroupRateLimitPerMinute, time.Minute) {
		return true
	}
	writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "too many group changes, please slow down")
	return false
}

func decodeGroupBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, dmGroupMaxBody)
	return decodeJSON(w, r, v)
}

// fanOutGroupChange tells every member of the group about a committed change:
// the refreshed dm_channel_open first, then the system rows. Both go out in
// order from this goroutine on the same per-connection queue, so an added user
// learns of the DM before the first row naming it. It runs on a context detached
// from the request: the change has committed and a client dropping right after
// must not make the rest of the room miss it.
func fanOutGroupChange(ctx context.Context, svc *service.Services, broadcaster DMBroadcaster, channelID int64, audience []int64, rows []service.GroupEventRow) {
	if broadcaster == nil {
		return
	}
	ctx = context.WithoutCancel(ctx)
	broadcastDMOpen(ctx, svc, broadcaster, channelID, audience)
	if len(rows) == 0 {
		return
	}
	sink, ok := broadcaster.(groupEventSink)
	if !ok {
		slog.Warn("fanOutGroupChange: broadcaster cannot deliver group rows", "channel_id", channelID)
		return
	}
	sink.GroupEventRows(ctx, channelID, audience, rows)
}

func handleAddGroupMembers(svc *service.Services, broadcaster DMBroadcaster, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		channelID, ok := parseIDParam(w, r, "channelId")
		if !ok {
			return
		}
		if !allowGroupMutation(w, limiter, user.ID) {
			return
		}
		var req addGroupMembersRequest
		if !decodeGroupBody(w, r, &req) {
			return
		}

		change, err := svc.DMs.AddGroupMembers(r.Context(), user.ID, channelID, req.UserIDs)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		fanOutGroupChange(r.Context(), svc, broadcaster, channelID, change.Audience, change.Rows)
		sendAddedVoiceRoster(r.Context(), broadcaster, channelID, change.Added)
		writeGroupSummary(w, r, svc, user.ID, channelID)
	}
}

func handleRemoveGroupMember(svc *service.Services, broadcaster DMBroadcaster, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		channelID, ok := parseIDParam(w, r, "channelId")
		if !ok {
			return
		}
		targetID, ok := parseIDParam(w, r, "userId")
		if !ok {
			return
		}
		if !allowGroupMutation(w, limiter, user.ID) {
			return
		}

		change, err := svc.DMs.RemoveGroupMember(r.Context(), user.ID, channelID, targetID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		// The removed member loses the DM and its call and gets no row; the room
		// hears "removed" from the remaining members only. dm_channel_close is
		// unsequenced, so bump the watermark BEFORE the send (see
		// markDMVisibilityChanged).
		bg := context.WithoutCancel(r.Context())
		if broadcaster != nil {
			markDMVisibilityChanged(broadcaster)
			closeMsg := fmt.Appendf(nil, `{"type":%q,"payload":{"channel_id":%d}}`, ws.MsgTypeDMChannelClose, channelID)
			if sent := broadcaster.SendToUser(targetID, closeMsg); !sent {
				slog.Debug("handleRemoveGroupMember: removed user not connected", "user_id", targetID, "channel_id", channelID)
			}
			if ve, evictable := broadcaster.(dmVoiceEvictor); evictable {
				ve.DisconnectFromVoiceInChannel(bg, targetID, channelID, ws.VoiceLeaveReasonDMRemoved)
			}
		}
		fanOutGroupChange(r.Context(), svc, broadcaster, channelID, change.Audience, change.Rows)
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleTransferGroupOwner hands a group DM to another member (owner only). It
// writes no row: members get a refreshed dm_channel_open with the new owner_id.
func handleTransferGroupOwner(svc *service.Services, broadcaster DMBroadcaster, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		channelID, ok := parseIDParam(w, r, "channelId")
		if !ok {
			return
		}
		if !allowGroupMutation(w, limiter, user.ID) {
			return
		}
		var req transferGroupOwnerRequest
		if !decodeGroupBody(w, r, &req) {
			return
		}

		change, err := svc.DMs.TransferGroupOwner(r.Context(), user.ID, channelID, req.UserID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		fanOutGroupChange(r.Context(), svc, broadcaster, channelID, change.Audience, nil)
		writeGroupSummary(w, r, svc, user.ID, channelID)
	}
}

// writeGroupSummary answers a committed group change with the caller's view of
// the group. If that read fails the change has still happened and fanned out, so
// an error status would invite a retry of a done change: it logs a warning and
// answers 204 instead; the caller gets the same summary from its
// dm_channel_open.
func writeGroupSummary(w http.ResponseWriter, r *http.Request, svc *service.Services, userID, channelID int64) {
	summary, err := svc.DMs.DMSummaryFor(context.WithoutCancel(r.Context()), userID, channelID)
	if err != nil {
		slog.Warn("writeGroupSummary: summary unavailable after a committed group change",
			"err", err, "user_id", userID, "channel_id", channelID)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, summary)
}
