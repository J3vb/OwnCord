package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
)

// DMBroadcaster sends WebSocket events from REST handlers; satisfied by *ws.Hub.
type DMBroadcaster interface {
	SendToUser(userID int64, msg []byte) bool
}

// dmVisibilityMarker is an optional DMBroadcaster capability: bump the hub's
// visibility watermark after an unsequenced, targeted event, so a client that
// warm-reconnects across the gap takes the full-ready path instead of a seq
// replay that can never redeliver it. Reached by type assertion so
// SendToUser-only test doubles keep working; ws.Hub.MarkVisibilityChanged
// satisfies it (ws/emit.go).
type dmVisibilityMarker interface {
	MarkVisibilityChanged()
}

// The production broadcaster must keep satisfying it: a type assertion that
// silently stops matching turns the bump into a no-op with nothing failing (as
// with the dmVoiceEvictor assertion below).
var _ dmVisibilityMarker = (*ws.Hub)(nil)

// markDMVisibilityChanged bumps the visibility watermark if broadcaster supports
// it. dm_channel_open/close are unsequenced and targeted, so a client that
// misses one and warm-reconnects never gets it from seq-replay; the WS emitter
// (ws/emit.go DMChannelOpenEvent) bumps unconditionally for the same reason.
// nsfw_handler.go uses it for nsfw_ack.
func markDMVisibilityChanged(broadcaster DMBroadcaster) {
	if vm, ok := broadcaster.(dmVisibilityMarker); ok {
		vm.MarkVisibilityChanged()
	}
}

// dmVoiceEvictor evicts a user's voice connection for ONE channel, leaving an
// unrelated call untouched (unlike DisconnectFromVoice). Reached by type
// assertion so SendToUser-only test doubles keep working.
type dmVoiceEvictor interface {
	DisconnectFromVoiceInChannel(ctx context.Context, userID, channelID int64, reason string) bool
}

// The production broadcaster must keep satisfying it, or eviction silently
// becomes a no-op.
var _ dmVoiceEvictor = (*ws.Hub)(nil)

// MountDMRoutes registers the authenticated DM routes. hub sends real-time
// events on DM close. store may be nil, in which case the group icon upload
// route is not registered: a route that 500s on every call is worse than one
// that 404s.
func MountDMRoutes(r chi.Router, svc *service.Services, broadcaster DMBroadcaster, limiter *auth.RateLimiter, store FileStore) {
	r.Route("/api/v1/dms", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Post("/", handleCreateDM(svc, broadcaster))
		r.Post("/group", handleCreateGroupDM(svc, broadcaster))
		r.Get("/", handleListDMs(svc))
		r.Patch("/{channelId}", handleRenameGroupDM(svc, broadcaster, limiter))
		r.Delete("/{channelId}", handleCloseDM(svc, broadcaster))
		r.Post("/{channelId}/members", handleAddGroupMembers(svc, broadcaster, limiter))
		r.Delete("/{channelId}/members/{userId}", handleRemoveGroupMember(svc, broadcaster, limiter))
		r.Put("/{channelId}/owner", handleTransferGroupOwner(svc, broadcaster, limiter))
		r.Delete("/{channelId}/icon", handleDeleteGroupIcon(svc, broadcaster, limiter))
		if store != nil {
			r.With(MaxBodySize(avatarMaxBodySize)).
				Post("/{channelId}/icon", handleUploadGroupIcon(svc, broadcaster, store, limiter))
		}
	})

	r.Route("/api/v1/blocks", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Get("/", handleListBlocks(svc))
		r.Put("/{userId}", handleBlockUser(svc, broadcaster))
		r.Delete("/{userId}", handleUnblockUser(svc))
	})
}

type createDMRequest struct {
	RecipientID int64 `json:"recipient_id"`
}

type createDMResponse struct {
	ChannelID int64     `json:"channel_id"`
	Recipient db.DMUser `json:"recipient"`
	Created   bool      `json:"created"`
}

type createGroupDMRequest struct {
	RecipientIDs []int64 `json:"recipient_ids"`
	Name         string  `json:"name"`
}

type renameDMRequest struct {
	Name string `json:"name"`
}

type listDMsResponse struct {
	DMChannels []db.DMChannelInfo `json:"dm_channels"`
}

func handleCreateDM(svc *service.Services, broadcaster DMBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		var req createDMRequest
		if !decodeJSON(w, r, &req) {
			return
		}

		result, err := svc.DMs.CreateDM(r.Context(), user.ID, req.RecipientID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		// A brand-new 1:1 DM has dm_open_state pre-seeded for BOTH users by
		// GetOrCreateDMChannel (db/dm_queries.go), so the recipient's first
		// OpenDM finds the row present and reports opened=false; without this
		// nothing tells the recipient the DM exists (no live event, no watermark
		// bump). Only creation needs it: re-opening an existing DM touches only
		// the caller's row.
		// RecipientOpened is false when the recipient does not yet trust the
		// caller: GetOrCreateDMChannelGated opens only the caller's side, so no
		// dm_channel_open goes out and the request frame from the first message
		// is their only signal until they accept.
		if result.Created && result.RecipientOpened {
			broadcastDMOpen(r.Context(), svc, broadcaster, result.Channel.ID, []int64{result.Recipient.ID})
		}

		if result.AcceptedRequest != nil {
			notifyDMRequestTransition(r.Context(), svc, broadcaster, user.ID, result.AcceptedRequest, true)
		}

		avatarStr := ""
		if result.Recipient.Avatar != nil {
			avatarStr = *result.Recipient.Avatar
		}
		displayName := ""
		if result.Recipient.DisplayName != nil {
			displayName = *result.Recipient.DisplayName
		}
		// PresentableStatus applies the live-status rule documented at
		// ws/serve_ready.go presentableMembers; StatusForViewer alone would ship
		// a disconnected recipient's saved idle/dnd or a connected one's
		// not-yet-flushed "offline".
		presented := svc.DMs.PresentableStatus(result.Recipient.ID, user.ID, db.StatusForViewer(result.Recipient.Status, result.Recipient.ID, user.ID))
		dmUser := db.DMUser{
			ID:          result.Recipient.ID,
			Username:    result.Recipient.Username,
			Avatar:      avatarStr,
			Status:      presented,
			Mobile:      svc.DMs.PresentableMobile(result.Recipient.ID, presented),
			DisplayName: displayName,
		}

		status := http.StatusOK
		if result.Created {
			status = http.StatusCreated
		}
		writeJSON(w, status, createDMResponse{
			ChannelID: result.Channel.ID,
			Recipient: dmUser,
			Created:   result.Created,
		})
	}
}

func handleListDMs(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		channels, err := svc.DMs.ListDMs(r.Context(), user.ID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, listDMsResponse{DMChannels: channels})
	}
}

func handleCloseDM(svc *service.Services, broadcaster DMBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		channelID, ok := parseIDParam(w, r, "channelId")
		if !ok {
			return
		}

		result, err := svc.DMs.CloseDM(r.Context(), user.ID, channelID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		if broadcaster != nil {
			// dm_channel_close is unsequenced and targeted (see
			// markDMVisibilityChanged). Bump BEFORE the send, as broadcastDMOpen
			// and the NSFW handlers do: a socket warm-reconnecting between the
			// two calls must already see the bumped watermark, since seq replay
			// can never redeliver the close frame.
			markDMVisibilityChanged(broadcaster)
			closeMsg := fmt.Appendf(nil, `{"type":%q,"payload":{"channel_id":%d}}`, ws.MsgTypeDMChannelClose, channelID)
			if ok := broadcaster.SendToUser(user.ID, closeMsg); !ok {
				slog.Debug("handleCloseDM: user not connected", "user_id", user.ID, "channel_id", channelID)
			}
			// A group leave changes the membership everyone renders, so
			// survivors get a refreshed dm_channel_open (carrying the new
			// owner_id if the leaver owned the group) before the group_leave
			// row.
			if result.Left && !result.ChannelDeleted {
				fanOutGroupChange(r.Context(), svc, broadcaster, channelID, result.RemainingParticipantIDs, result.Rows)
			}
			// Without this a leaver stays connected to the group's live voice
			// call, hearing a room they no longer belong to. Scoped to this
			// channel so an unrelated call is untouched. It also covers the
			// last-participant case (ChannelDeleted): the row is gone, so
			// CleanupVoiceForChannel would read an FK-cascaded empty
			// voice_states and do nothing.
			if result.Left {
				if ve, ok := broadcaster.(dmVoiceEvictor); ok {
					ve.DisconnectFromVoiceInChannel(context.WithoutCancel(r.Context()), user.ID, channelID, ws.VoiceLeaveReasonDMLeave)
				}
			}
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// broadcastDMOpen sends a per-viewer dm_channel_open for channelID to each of
// targetIDs; the payload is relative to the reader, so it is rebuilt per target.
// Failures are logged and skipped: the mutation has committed and a client that
// misses the event re-derives the state from its next `ready`.
func broadcastDMOpen(ctx context.Context, svc *service.Services, broadcaster DMBroadcaster, channelID int64, targetIDs []int64) {
	if broadcaster == nil || len(targetIDs) == 0 {
		return
	}
	// The mutation has already committed, so the fan-out must survive the
	// request context being cancelled (client disconnect); otherwise every
	// DMSummaryFor lookup fails with context.Canceled and no participant gets
	// the open.
	ctx = context.WithoutCancel(ctx)
	// dm_channel_open is unsequenced and targeted, so a recipient who drops now
	// cannot get it from seq resume; force warm reconnects onto the full-ready
	// path. Bumped once per call, unconditionally (not per SendToUser result),
	// like the ws emitter (ws/emit.go); this covers group create, the rename
	// refresh and the group-leave refresh.
	markDMVisibilityChanged(broadcaster)
	for _, pid := range targetIDs {
		summary, pErr := svc.DMs.DMSummaryFor(ctx, pid, channelID)
		if pErr != nil {
			slog.Debug("broadcastDMOpen: summary unavailable", "user_id", pid, "channel_id", channelID, "err", pErr)
			continue
		}
		msg, mErr := json.Marshal(map[string]any{
			"type":    "dm_channel_open",
			"payload": summary,
		})
		if mErr != nil {
			slog.Warn("broadcastDMOpen: marshal failed", "err", mErr, "channel_id", channelID)
			continue
		}
		if ok := broadcaster.SendToUser(pid, msg); !ok {
			slog.Debug("broadcastDMOpen: user not connected", "user_id", pid, "channel_id", channelID)
		}
	}
}

func handleCreateGroupDM(svc *service.Services, broadcaster DMBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		var req createGroupDMRequest
		if !decodeJSON(w, r, &req) {
			return
		}

		result, err := svc.DMs.CreateGroupDM(r.Context(), user.ID, req.RecipientIDs, req.Name)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		// Everyone, the creator included, gets the DM in their sidebar
		// immediately: the REST response is only the creator's copy and a second
		// window needs the event too.
		broadcastDMOpen(r.Context(), svc, broadcaster, result.Channel.ID, result.ParticipantIDs)

		writeJSON(w, http.StatusCreated,
			db.NewDMChannelInfo(result.Channel.ID, result.Channel.Name, true, user.ID, "", result.Participants, user.ID))
	}
}

// handleRenameGroupDM sets or clears a group DM's name (any member). A changed
// name leaves a group_rename row; an unchanged one sends nothing.
func handleRenameGroupDM(svc *service.Services, broadcaster DMBroadcaster, limiter *auth.RateLimiter) http.HandlerFunc {
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

		var req renameDMRequest
		if !decodeJSON(w, r, &req) {
			return
		}

		result, err := svc.DMs.RenameGroupDM(r.Context(), user.ID, channelID, req.Name)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		// The rename has committed, so the fan-out runs on a context detached
		// from the request; otherwise participants keep the stale name, since
		// dm_channel_open is unsequenced/targeted and can't be replayed. An
		// unchanged name wrote no row and sends nothing.
		if len(result.Rows) > 0 {
			fanOutGroupChange(r.Context(), svc, broadcaster, channelID, result.Audience, result.Rows)
		}

		writeGroupSummary(w, r, svc, user.ID, channelID)
	}
}

func handleBlockUser(svc *service.Services, broadcaster DMBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		targetID, ok := parseIDParam(w, r, "userId")
		if !ok {
			return
		}

		if err := svc.Blocks.BlockUser(r.Context(), user.ID, targetID); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		evictBlockedUserFromVoice(context.WithoutCancel(r.Context()), svc, broadcaster, user.ID, targetID)

		writeJSON(w, http.StatusOK, map[string]string{"message": "user blocked"})
	}
}

// evictBlockedUserFromVoice evicts targetID from the pair's shared 1:1 DM voice
// call, the post-block step PUT /api/v1/blocks/{id} and POST
// /api/v1/dm-requests/{id}/block owe once BlockUser commits. Callers pass a
// context detached from the request (context.WithoutCancel) so a disconnect
// cannot skip it.
// Revocation must evict a live session, not just block the next join: the block
// gate runs only on voice_join and voice_token_refresh, which the blocked client
// controls. Group DM calls are untouched, matching RequireDMReachable's group
// exemption.
func evictBlockedUserFromVoice(ctx context.Context, svc *service.Services, broadcaster DMBroadcaster, blockerID, targetID int64) {
	ve, evictable := broadcaster.(dmVoiceEvictor)
	if !evictable {
		return
	}
	chID, exists, err := svc.DMs.SharedOneToOneDM(ctx, blockerID, targetID)
	if err != nil {
		slog.Warn("block: shared-DM lookup for voice eviction failed",
			"blocker_id", blockerID, "target_id", targetID, "err", err)
		return
	}
	if exists {
		ve.DisconnectFromVoiceInChannel(ctx, targetID, chID, ws.VoiceLeaveReasonBlocked)
	}
}

func handleUnblockUser(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		targetID, ok := parseIDParam(w, r, "userId")
		if !ok {
			return
		}

		if err := svc.Blocks.UnblockUser(r.Context(), user.ID, targetID); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"message": "user unblocked"})
	}
}

func handleListBlocks(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		ids, err := svc.Blocks.ListBlocked(r.Context(), user.ID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"blocked_user_ids": ids})
	}
}
