package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/db"
)

// handleBlockUser blocks a user (prevents DM creation and messaging).
func handleBlockUser(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := getUserFromContext(r)
		if user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		targetID, err := strconv.ParseInt(chi.URLParam(r, "userId"), 10, 64)
		if err != nil || targetID <= 0 {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: "invalid user ID",
			})
			return
		}

		if targetID == user.ID {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: "cannot block yourself",
			})
			return
		}

		// Verify target user exists.
		target, err := database.GetUserByID(targetID)
		if err != nil {
			slog.Error("handleBlockUser GetUserByID", "err", err, "target_id", targetID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to look up user",
			})
			return
		}
		if target == nil {
			writeJSON(w, http.StatusNotFound, errorResponse{
				Error:   "NOT_FOUND",
				Message: "user not found",
			})
			return
		}

		if err := database.BlockUser(user.ID, targetID); err != nil {
			slog.Error("handleBlockUser BlockUser", "err", err,
				"blocker_id", user.ID, "blocked_id", targetID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to block user",
			})
			return
		}

		slog.Info("user blocked", "blocker_id", user.ID, "blocked_id", targetID)
		writeJSON(w, http.StatusOK, map[string]string{"message": "user blocked"})
	}
}

// handleUnblockUser removes a block on a user.
func handleUnblockUser(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := getUserFromContext(r)
		if user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		targetID, err := strconv.ParseInt(chi.URLParam(r, "userId"), 10, 64)
		if err != nil || targetID <= 0 {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: "invalid user ID",
			})
			return
		}

		if err := database.UnblockUser(user.ID, targetID); err != nil {
			slog.Error("handleUnblockUser UnblockUser", "err", err,
				"blocker_id", user.ID, "target_id", targetID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to unblock user",
			})
			return
		}

		slog.Info("user unblocked", "blocker_id", user.ID, "unblocked_id", targetID)
		writeJSON(w, http.StatusOK, map[string]string{"message": "user unblocked"})
	}
}

// handleListBlocks returns all users blocked by the authenticated user.
func handleListBlocks(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := getUserFromContext(r)
		if user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		ids, err := database.ListBlockedUsers(user.ID)
		if err != nil {
			slog.Error("handleListBlocks ListBlockedUsers", "err", err, "user_id", user.ID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to list blocked users",
			})
			return
		}
		if ids == nil {
			ids = []int64{}
		}

		writeJSON(w, http.StatusOK, map[string]any{"blocked_user_ids": ids})
	}
}
