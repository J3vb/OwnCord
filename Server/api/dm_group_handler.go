package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// Group DM membership routes: add, remove and owner transfer; leave and rename live in dm_handler.go.

// dmGroupRateLimitPerMinute bounds, per user, the group mutations that publish to other members.
const dmGroupRateLimitPerMinute = 20

// Group creation has its own budget, apart from the mutation one: a short burst limit and a daily ceiling.
const (
	dmGroupCreatePerMinute = 5
	dmGroupCreatePerDay    = 50
	dmGroupCreateMinuteKey = "dm_group_create_min"
	dmGroupCreateDayKey    = "dm_group_create_day"
)

const dmGroupMaxBody = 1 << 14

// groupEventSink is the DMBroadcaster capability that delivers group system rows as sequenced chat_message
// frames. Reached by type assertion; the production broadcaster must keep satisfying it or the rows
// silently stop.
type groupEventSink interface {
	GroupEventRows(ctx context.Context, channelID int64, audience []int64, rows []service.GroupEventRow)
}

var _ groupEventSink = (*ws.Hub)(nil)

// dmVoiceRosterSender tells one user who is in a DM's call now. Reached by type assertion like
// groupEventSink; the production broadcaster must keep satisfying it or a member added mid-call loses the
// roster.
type dmVoiceRosterSender interface {
	SendDMVoiceRoster(ctx context.Context, userID, channelID int64)
}

var _ dmVoiceRosterSender = (*ws.Hub)(nil)

// sendAddedVoiceRoster hands each added member the call's voice states; it runs after fanOutGroupChange so
// dm_channel_open comes first.
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

// allowGroupMutation applies the per-user limit and writes the 429 itself; a nil limiter allows.
func allowGroupMutation(w http.ResponseWriter, limiter *auth.RateLimiter, userID int64) bool {
	if limiter == nil || limiter.Allow(auth.Key("dm_group", userID), dmGroupRateLimitPerMinute, time.Minute) {
		return true
	}
	writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "too many group changes, please slow down")
	return false
}

// allowGroupCreate applies both creation limits and writes the 429 itself; a nil limiter allows. A call the
// daily ceiling refuses gives its minute slot back.
func allowGroupCreate(w http.ResponseWriter, limiter *auth.RateLimiter, userID int64) bool {
	if limiter == nil {
		return true
	}
	minuteKey := auth.Key(dmGroupCreateMinuteKey, userID)
	refund, ok := limiter.Reserve(minuteKey, dmGroupCreatePerMinute, time.Minute)
	if !ok {
		writeGroupCreateLimited(w, limiter.RetryAfter(minuteKey, dmGroupCreatePerMinute, time.Minute))
		return false
	}
	dayKey := auth.Key(dmGroupCreateDayKey, userID)
	if !limiter.Allow(dayKey, dmGroupCreatePerDay, 24*time.Hour) {
		refund()
		writeGroupCreateLimited(w, limiter.RetryAfter(dayKey, dmGroupCreatePerDay, 24*time.Hour))
		return false
	}
	return true
}

func writeGroupCreateLimited(w http.ResponseWriter, retryAfter time.Duration) {
	secs := int((retryAfter + time.Second - 1) / time.Second)
	w.Header().Set("Retry-After", strconv.Itoa(max(secs, 1)))
	writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "too many new groups, please try again later")
}

func decodeGroupBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, dmGroupMaxBody)
	return decodeJSON(w, r, v)
}

// fanOutGroupChange tells every member about a committed change: the refreshed dm_channel_open first, then
// the system rows, in order on the same per-connection queue so an added user learns of the DM before the
// first row naming it. It runs on a context detached from the request: a client dropping right after must
// not make the room miss it.
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

		// The removed member loses the DM and its call and gets no row. dm_channel_close is unsequenced, so
		// bump the watermark BEFORE the send (see markDMVisibilityChanged).
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

// handleTransferGroupOwner hands a group DM to another member (owner only); no row, members get a
// dm_channel_open with the new owner_id.
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

// writeGroupSummary answers a committed change with the caller's view. If that read fails the change has
// still fanned out, so an error status would invite a retry: it logs and answers 204 instead.
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
