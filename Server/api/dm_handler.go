package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
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
		r.Get("/", handleListDMs(svc))
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
			writeServiceError(w, err)
			return
		}

		avatarStr := ""
		if result.Recipient.Avatar != nil {
			avatarStr = *result.Recipient.Avatar
		}
		dmUser := db.DMUser{
			ID:       result.Recipient.ID,
			Username: result.Recipient.Username,
			Avatar:   avatarStr,
			Status:   result.Recipient.Status,
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
			writeServiceError(w, err)
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

		if err := svc.DMs.CloseDM(r.Context(), user.ID, channelID); err != nil {
			writeServiceError(w, err)
			return
		}

		// Notify via WebSocket so sidebar updates immediately.
		if broadcaster != nil {
			closeMsg := []byte(fmt.Sprintf(`{"type":"dm_channel_close","payload":{"channel_id":%d}}`, channelID))
			if ok := broadcaster.SendToUser(user.ID, closeMsg); !ok {
				slog.Debug("handleCloseDM: user not connected", "user_id", user.ID, "channel_id", channelID)
			}
		}

		w.WriteHeader(http.StatusNoContent)
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
			writeServiceError(w, err)
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
			writeServiceError(w, err)
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
			writeServiceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"blocked_user_ids": ids})
	}
}
