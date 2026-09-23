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
	if errors.Is(err, service.ErrConflict) {
		writeErr(w, http.StatusConflict, "STALE_RETENTION_POLICY", err.Error())
		return
	}
	writeSvcErr(w, err, "", "", "retention change failed")
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
		err = retention.ApplyChange(r.Context(), actorFromContext(r), service.RetentionChange{Scope: "channel", ChannelID: id, Days: &req.Days}, r.Header.Get("X-Retention-Preview"))
		if err != nil {
			writeRetentionErr(w, err)
			return
		}
		policy, err := retention.ChannelPolicy(r.Context(), id)
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
		if err := retention.ApplyChange(r.Context(), actorFromContext(r), service.RetentionChange{Scope: "channel", ChannelID: id}, r.Header.Get("X-Retention-Preview")); err != nil {
			writeRetentionErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handlePostRetentionPreview calculates a proposed policy without saving it.
func handlePostRetentionPreview(retention *service.RetentionService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if retention == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "retention service unavailable")
			return
		}
		var req struct {
			Proposed service.RetentionChange `json:"proposed"`
			Revision string                  `json:"revision"`
		}
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}
		preview, err := retention.PreviewChange(r.Context(), actorFromContext(r), req.Proposed, req.Revision)
		if err != nil {
			writeRetentionErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, preview)
	}
}
