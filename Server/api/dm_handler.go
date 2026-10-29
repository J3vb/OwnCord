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

// DMBroadcaster is the interface needed to send WebSocket events from REST
// handlers. Satisfied by *ws.Hub.
type DMBroadcaster interface {
	SendToUser(userID int64, msg []byte) bool
}

// dmVisibilityMarker is an optional DMBroadcaster capability: bump the hub's
// visibility watermark after an unsequenced, targeted event so a client that
// warm-reconnects across the gap takes the full-ready path instead of a
// sequenced-only replay that can never redeliver it. Reached by type
// assertion rather than being added to DMBroadcaster directly so the
// SendToUser-only test doubles in this package keep working. Satisfied in
// production by ws.Hub.MarkVisibilityChanged, which forwards to the same
// bumpVisibilityWatermark the WS-side dm_channel_open emitter uses
// (ws/emit.go).
type dmVisibilityMarker interface {
	MarkVisibilityChanged()
}

// The production broadcaster must keep satisfying it: a type assertion that
// silently stops matching would turn the watermark bump back into the no-op
// this fixed, with nothing failing to say so — mirrors the dmVoiceEvictor
// assertion below for its sibling capability.
var _ dmVisibilityMarker = (*ws.Hub)(nil)

// markDMVisibilityChanged bumps the visibility watermark if broadcaster
// supports it. dm_channel_open/close are unsequenced and targeted, so a
// client that misses one via a dropped connection and then warm-reconnects
// never gets it redelivered by the ordinary seq-replay path — mirroring why
// the WS emitter of the same event (ws/emit.go DMChannelOpenEvent) forces
// this bump unconditionally, regardless of whether the send itself
// succeeded. Also called by nsfw_handler.go: nsfw_ack is the same
// shape of unsequenced, targeted event.
func markDMVisibilityChanged(broadcaster DMBroadcaster) {
	if vm, ok := broadcaster.(dmVisibilityMarker); ok {
		vm.MarkVisibilityChanged()
	}
}

// dmVoiceEvictor is the DMBroadcaster capability used to evict a user's
// voice-call connection for one specific channel, leaving an unrelated call
// they may currently be in untouched (which the unconditional
// DisconnectFromVoice would not). It is kept out of DMBroadcaster itself and
// reached by type assertion so the handler stays usable with the
// SendToUser-only test doubles the package already has.
type dmVoiceEvictor interface {
	DisconnectFromVoiceInChannel(ctx context.Context, userID, channelID int64, reason string) bool
}

// The production broadcaster must keep satisfying it: a type assertion that
// silently stops matching would turn the eviction back into the no-op this
// fixed, with nothing failing to say so.
var _ dmVoiceEvictor = (*ws.Hub)(nil)

// MountDMRoutes registers DM-related routes onto r.
// All routes require authentication.
// hub is used to send real-time WebSocket events on DM close. store may be nil,
// in which case the group icon upload route is not registered: with nowhere to
// put the bytes, a route that 500s on every call is worse than one that 404s.
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

	// User blocking routes — prevent DM creation and messaging.
	r.Route("/api/v1/blocks", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Get("/", handleListBlocks(svc))
		r.Put("/{userId}", handleBlockUser(svc, broadcaster))
		r.Delete("/{userId}", handleUnblockUser(svc))
	})
}

// createDMRequest is the JSON body for POST /api/v1/dms.
type createDMRequest struct {
	RecipientID int64 `json:"recipient_id"`
}

// createDMResponse is the JSON response for POST /api/v1/dms.
type createDMResponse struct {
	ChannelID int64     `json:"channel_id"`
	Recipient db.DMUser `json:"recipient"`
	Created   bool      `json:"created"`
}

// createGroupDMRequest is the JSON body for POST /api/v1/dms/group.
type createGroupDMRequest struct {
	RecipientIDs []int64 `json:"recipient_ids"`
	Name         string  `json:"name"`
}

// renameDMRequest is the JSON body for PATCH /api/v1/dms/{channelId}.
type renameDMRequest struct {
	Name string `json:"name"`
}

// listDMsResponse is the JSON response for GET /api/v1/dms.
type listDMsResponse struct {
	DMChannels []db.DMChannelInfo `json:"dm_channels"`
}

// handleCreateDM creates or retrieves a DM channel with a recipient.
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
		// OpenDM call — fired later from the sender's first message — finds
		// the row already present and reports opened=false. Without this,
		// nothing ever tells the recipient the DM exists: no live event, and
		// no visibility-watermark bump for a warm reconnect either. Only the
		// creation path needs this — CreateDM re-opening an existing DM for
		// the caller only touches the caller's own dm_open_state row, which
		// the caller obviously already knows about.
		// RecipientOpened is false when the recipient does not yet trust the
		// caller: GetOrCreateDMChannelGated decides the recipient's
		// side inside its own transaction and opens only the caller's, so no
		// dm_channel_open goes out — the request frame from the first
		// message is their only signal until they accept.
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
		// PresentableStatus applies the live-status rule ws/serve_ready.go's
		// presentableMembers documents — StatusForViewer on the row alone
		// would ship a disconnected recipient's saved idle/dnd verbatim
		// or a connected one's not-yet-flushed "offline".
		dmUser := db.DMUser{
			ID:          result.Recipient.ID,
			Username:    result.Recipient.Username,
			Avatar:      avatarStr,
			Status:      svc.DMs.PresentableStatus(result.Recipient.ID, user.ID, db.StatusForViewer(result.Recipient.Status, result.Recipient.ID, user.ID)),
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

// handleListDMs returns all open DM channels for the authenticated user.
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

// handleCloseDM removes a DM channel from the authenticated user's open list.
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

		// Notify via WebSocket so sidebar updates immediately.
		if broadcaster != nil {
			// dm_channel_close is unsequenced and targeted like
			// dm_channel_open — see markDMVisibilityChanged. Bump BEFORE the
			// send, same ordering broadcastDMOpen and the NSFW handlers use: a
			// socket that warm-reconnects in the gap between these two calls
			// must already observe the bumped watermark, since the close frame
			// itself can never be redelivered by seq replay.
			markDMVisibilityChanged(broadcaster)
			closeMsg := fmt.Appendf(nil, `{"type":%q,"payload":{"channel_id":%d}}`, ws.MsgTypeDMChannelClose, channelID)
			if ok := broadcaster.SendToUser(user.ID, closeMsg); !ok {
				slog.Debug("handleCloseDM: user not connected", "user_id", user.ID, "channel_id", channelID)
			}
			// A group leave changes the membership everyone else renders, so
			// the survivors get a refreshed dm_channel_open (it carries the new
			// owner_id when the leaver owned the group) rather than being left
			// showing a member who has gone, then the group_leave row.
			if result.Left && !result.ChannelDeleted {
				fanOutGroupChange(r.Context(), svc, broadcaster, channelID, result.RemainingParticipantIDs, result.Rows)
			}
			// Leaving a group DM removes the caller from its membership but,
			// without this, leaves them connected to its live voice call —
			// they keep hearing and speaking to a room they are no longer a
			// member of. Scoped to this channel so a leaver currently on an
			// unrelated voice call is untouched. This also covers the
			// last-participant case (ChannelDeleted): the row is already gone
			// by now, so CleanupVoiceForChannel would read an FK-cascaded
			// empty voice_states and do nothing, while the leaver — the only
			// participant left — is evicted here.
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
// targetIDs. The payload differs per addressee (`recipient`/`recipients` are
// relative to who is reading), so it is rebuilt inside the loop.
//
// Failures are logged and skipped, never surfaced: the mutation that prompted
// this has already committed, and a client that misses the event re-derives
// the same state from its next `ready`.
func broadcastDMOpen(ctx context.Context, svc *service.Services, broadcaster DMBroadcaster, channelID int64, targetIDs []int64) {
	if broadcaster == nil || len(targetIDs) == 0 {
		return
	}
	// The mutation that led here has already committed, so this fan-out must
	// survive the caller's request context being cancelled after that point
	// (client disconnect mid-handler) — otherwise every DMSummaryFor lookup
	// below fails with context.Canceled and no participant, including ones
	// otherwise unaffected by the cancellation, ever receives the open.
	ctx = context.WithoutCancel(ctx)
	// dm_channel_open is unsequenced and targeted — a recipient who is
	// offline or drops the connection right now can never have it replayed
	// to them by the ordinary seq-based resume path, so a warm reconnect must
	// be forced onto the full-ready path instead. Bumped once per call,
	// unconditionally (not per-recipient SendToUser result): the ws emitter
	// of this same event does the same (ws/emit.go), and this covers every
	// caller — group create, rename refresh, and the group-leave refresh.
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

// handleCreateGroupDM creates a group DM between the caller and 2..8 others.
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

		// Everyone gets the DM in their sidebar immediately, the creator
		// included — the REST response is only the creator's copy, and a
		// second window of theirs needs the event just as much as the others.
		broadcastDMOpen(r.Context(), svc, broadcaster, result.Channel.ID, result.ParticipantIDs)

		writeJSON(w, http.StatusCreated,
			db.NewDMChannelInfo(result.Channel.ID, result.Channel.Name, true, user.ID, "", result.Participants, user.ID))
	}
}

// handleRenameGroupDM sets or clears a group DM's name. Any member may rename.
// A changed name leaves a group_rename row; an unchanged one sends nothing.
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

		// The rename has already committed at this point, so the fan-out runs on
		// a context detached from the request (client disconnect mid-handler),
		// and participants would keep rendering the stale name with no
		// compensating resync otherwise, since dm_channel_open is
		// unsequenced/targeted and can't be replayed. An unchanged name wrote no
		// row and changed nothing for anyone, so it sends nothing.
		if len(result.Rows) > 0 {
			fanOutGroupChange(r.Context(), svc, broadcaster, channelID, result.Audience, result.Rows)
		}

		writeGroupSummary(w, r, svc, user.ID, channelID)
	}
}

// handleBlockUser blocks a user.
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

// evictBlockedUserFromVoice evicts targetID from the pair's shared 1:1 DM
// voice call, if any — the post-block step both PUT /api/v1/blocks/{id} and
// POST /api/v1/dm-requests/{id}/block owe once BlockUser
// itself has committed. Callers pass a context detached from the request
// (context.WithoutCancel): the block has already committed by the time this
// runs, so a client disconnecting mid-handler must not silently skip it.
//
// Revocation must evict a live session, not merely block the next join (the
// same invariant the voice sweep states): without this, a blocked user
// already in the pair's 1:1 DM voice call stays in it indefinitely — the
// block gate otherwise runs only on voice_join and voluntary
// voice_token_refresh, both of which the blocked client controls. Group DM
// calls are deliberately untouched, matching RequireDMReachable's group
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

// handleUnblockUser unblocks a user.
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

// handleListBlocks returns all blocked user IDs.
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
