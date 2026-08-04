package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
	"github.com/owncord/server/ws"
)

// DMBroadcaster is the interface needed to send WebSocket events from REST
// handlers. Satisfied by *ws.Hub.
type DMBroadcaster interface {
	SendToUser(userID int64, msg []byte) bool
}

// MountDMRoutes registers DM-related routes onto r.
// All routes require authentication.
// hub is used to send real-time WebSocket events on DM close.
func MountDMRoutes(r chi.Router, database *db.DB, svc *service.Services, broadcaster DMBroadcaster) {
	r.Route("/api/v1/dms", func(r chi.Router) {
		r.Use(AuthMiddleware(database))
		r.Post("/", handleCreateDM(svc))
		r.Post("/group", handleCreateGroupDM(svc, broadcaster))
		r.Get("/", handleListDMs(svc))
		r.Patch("/{channelId}", handleRenameGroupDM(svc, broadcaster))
		r.Delete("/{channelId}", handleCloseDM(svc, broadcaster))
	})

	// User blocking routes — prevent DM creation and messaging.
	r.Route("/api/v1/blocks", func(r chi.Router) {
		r.Use(AuthMiddleware(database))
		r.Get("/", handleListBlocks(svc))
		r.Put("/{userId}", handleBlockUser(svc))
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
func handleCreateDM(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "authentication required",
			})
			return
		}

		var req createDMRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "BAD_REQUEST", Message: "invalid request body",
			})
			return
		}

		result, err := svc.DMs.CreateDM(r.Context(), user.ID, req.RecipientID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		avatarStr := ""
		if result.Recipient.Avatar != nil {
			avatarStr = *result.Recipient.Avatar
		}
		displayName := ""
		if result.Recipient.DisplayName != nil {
			displayName = *result.Recipient.DisplayName
		}
		dmUser := db.DMUser{
			ID:          result.Recipient.ID,
			Username:    result.Recipient.Username,
			Avatar:      avatarStr,
			Status:      db.StatusForViewer(result.Recipient.Status, result.Recipient.ID, user.ID),
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
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "authentication required",
			})
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
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "authentication required",
			})
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
			closeMsg := fmt.Appendf(nil, `{"type":%q,"payload":{"channel_id":%d}}`, ws.MsgTypeDMChannelClose, channelID)
			if ok := broadcaster.SendToUser(user.ID, closeMsg); !ok {
				slog.Debug("handleCloseDM: user not connected", "user_id", user.ID, "channel_id", channelID)
			}
			// A group leave changes the membership everyone else renders, so
			// the survivors get a refreshed dm_channel_open rather than being
			// left showing a member who has gone.
			if result.Left && !result.ChannelDeleted {
				broadcastDMOpen(r.Context(), svc, broadcaster, channelID, result.RemainingParticipantIDs)
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
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "authentication required",
			})
			return
		}

		var req createGroupDMRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "BAD_REQUEST", Message: "invalid request body",
			})
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
			db.NewDMChannelInfo(result.Channel.ID, result.Channel.Name, true, result.Participants, user.ID))
	}
}

// handleRenameGroupDM sets or clears a group DM's name. Participants only —
// there is no owner, so every member holds the same authority over it.
func handleRenameGroupDM(svc *service.Services, broadcaster DMBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "authentication required",
			})
			return
		}

		channelID, ok := parseIDParam(w, r, "channelId")
		if !ok {
			return
		}

		var req renameDMRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "BAD_REQUEST", Message: "invalid request body",
			})
			return
		}

		if _, err := svc.DMs.RenameGroupDM(r.Context(), user.ID, channelID, req.Name); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		participantIDs, pErr := svc.Channels.GetDMParticipantIDs(r.Context(), channelID)
		if pErr == nil {
			broadcastDMOpen(r.Context(), svc, broadcaster, channelID, participantIDs)
		}

		summary, sErr := svc.DMs.DMSummaryFor(r.Context(), user.ID, channelID)
		if sErr != nil {
			writeServiceError(r.Context(), w, sErr)
			return
		}
		writeJSON(w, http.StatusOK, summary)
	}
}

// handleBlockUser blocks a user.
func handleBlockUser(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, _ := r.Context().Value(UserKey).(*db.User)
		if user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "authentication required"})
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
		writeJSON(w, http.StatusOK, map[string]string{"message": "user blocked"})
	}
}

// handleUnblockUser unblocks a user.
func handleUnblockUser(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, _ := r.Context().Value(UserKey).(*db.User)
		if user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "authentication required"})
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
		user, _ := r.Context().Value(UserKey).(*db.User)
		if user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "authentication required"})
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
