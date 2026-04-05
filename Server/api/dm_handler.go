package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/db"
)

// DMBroadcaster is the interface needed to send WebSocket events from REST
// handlers. Satisfied by *ws.Hub.
type DMBroadcaster interface {
	SendToUser(userID int64, msg []byte) bool
}

// MountDMRoutes registers DM-related routes onto r.
// All routes require authentication.
// hub is used to send real-time WebSocket events on DM close.
func MountDMRoutes(r chi.Router, database *db.DB, broadcaster DMBroadcaster) {
	r.Route("/api/v1/dms", func(r chi.Router) {
		r.Use(AuthMiddleware(database))
		r.Post("/", handleCreateDM(database))
		r.Get("/", handleListDMs(database))
		r.Delete("/{channelId}", handleCloseDM(database, broadcaster))
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
func handleCreateDM(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "authentication required",
			})
			return
		}

		var req createDMRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: "invalid request body",
			})
			return
		}

		if req.RecipientID <= 0 {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: "recipient_id must be a positive integer",
			})
			return
		}

		// Cannot DM yourself.
		if req.RecipientID == user.ID {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: "cannot create a DM with yourself",
			})
			return
		}

		// Verify recipient exists.
		recipient, err := database.GetUserByID(req.RecipientID)
		if err != nil {
			slog.Error("handleCreateDM GetUserByID", "err", err, "recipient_id", req.RecipientID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to look up recipient",
			})
			return
		}
		if recipient == nil {
			writeJSON(w, http.StatusNotFound, errorResponse{
				Error:   "NOT_FOUND",
				Message: "recipient not found",
			})
			return
		}

		// Get or create the DM channel.
		ch, created, err := database.GetOrCreateDMChannel(user.ID, req.RecipientID) //nolint:contextcheck // TODO: propagate context through this call path
		if err != nil {
			slog.Error("handleCreateDM GetOrCreateDMChannel", "err", err,
				"user_id", user.ID, "recipient_id", req.RecipientID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to create DM channel",
			})
			return
		}

		// Build the recipient DMUser from the fetched user.
		avatarStr := ""
		if recipient.Avatar != nil {
			avatarStr = *recipient.Avatar
		}
		dmUser := db.DMUser{
			ID:       recipient.ID,
			Username: recipient.Username,
			Avatar:   avatarStr,
			Status:   recipient.Status,
		}

		status := http.StatusOK
		if created {
			status = http.StatusCreated
		}

		writeJSON(w, status, createDMResponse{
			ChannelID: ch.ID,
			Recipient: dmUser,
			Created:   created,
		})
	}
}

// handleListDMs returns all open DM channels for the authenticated user.
func handleListDMs(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "authentication required",
			})
			return
		}

		channels, err := database.GetUserDMChannels(user.ID)
		if err != nil {
			slog.Error("handleListDMs GetUserDMChannels", "err", err, "user_id", user.ID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to list DM channels",
			})
			return
		}

		writeJSON(w, http.StatusOK, listDMsResponse{DMChannels: channels})
	}
}

// handleCloseDM removes a DM channel from the authenticated user's open list.
func handleCloseDM(database *db.DB, broadcaster DMBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "authentication required",
			})
			return
		}

		channelID, ok := parseIDParam(w, r, "channelId")
		if !ok {
			return
		}

		// Verify user is a participant in this DM.
		isParticipant, err := database.IsDMParticipant(user.ID, channelID)
		if err != nil {
			slog.Error("handleCloseDM IsDMParticipant", "err", err,
				"user_id", user.ID, "channel_id", channelID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to verify DM participation",
			})
			return
		}
		if !isParticipant {
			writeJSON(w, http.StatusNotFound, errorResponse{
				Error:   "NOT_FOUND",
				Message: "channel not found",
			})
			return
		}

		if err := database.CloseDM(user.ID, channelID); err != nil {
			slog.Error("handleCloseDM CloseDM", "err", err,
				"user_id", user.ID, "channel_id", channelID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to close DM",
			})
			return
		}

		// Notify the closing user's WebSocket connections so the sidebar updates
		// immediately without waiting for a reconnect.
		if broadcaster != nil {
			closeMsg := []byte(fmt.Sprintf(`{"type":"dm_channel_close","payload":{"channel_id":%d}}`, channelID))
			if ok := broadcaster.SendToUser(user.ID, closeMsg); !ok {
				slog.Debug("handleCloseDM: user not connected, WS notify skipped",
					"user_id", user.ID, "channel_id", channelID)
			}
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
