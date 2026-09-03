package admin

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/J3vb/OwnCord/Server/service"
)

// ─── Retention (B4-11) ───────────────────────────────────────────────────────

// handleGetRetention returns the policy: the server window and every
// channel override.
func handleGetRetention(retention *service.RetentionService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if retention == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "retention service unavailable")
			return
		}
		policy, err := retention.Policy(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to read retention policy")
			return
		}
		writeJSON(w, http.StatusOK, policy)
	}
}

// handleGetRetentionPreview is the owner-facing effect preview: per channel
// with an effective window, how many messages the next sweep removes.
func handleGetRetentionPreview(retention *service.RetentionService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if retention == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "retention service unavailable")
			return
		}
		preview, err := retention.Preview(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to preview retention")
			return
		}
		writeJSON(w, http.StatusOK, preview)
	}
}

// putChannelRetentionRequest is the JSON body for
// PUT /admin/api/channels/{id}/retention.
type putChannelRetentionRequest struct {
	// Days is the channel's window; 0 keeps the channel forever even under
	// a server-wide window.
	Days int `json:"days"`
}

func writeRetentionErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrNotFound):
		writeErr(w, http.StatusNotFound, "NOT_FOUND", err.Error())
	case errors.Is(err, service.ErrBadRequest):
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "retention change failed")
	}
}

// handlePutChannelRetention sets a channel's override.
func handlePutChannelRetention(retention *service.RetentionService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid channel id")
			return
		}
		var req putChannelRetentionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}
		if retention == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "retention service unavailable")
			return
		}
		policy, err := retention.SetChannelPolicy(r.Context(), actorFromContext(r), id, req.Days)
		if err != nil {
			writeRetentionErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, policy)
	}
}

// handleDeleteChannelRetention removes a channel's override.
func handleDeleteChannelRetention(retention *service.RetentionService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid channel id")
			return
		}
		if retention == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "retention service unavailable")
			return
		}
		if err := retention.ClearChannelPolicy(r.Context(), actorFromContext(r), id); err != nil {
			writeRetentionErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
