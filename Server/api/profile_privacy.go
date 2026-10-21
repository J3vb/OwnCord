// profile_privacy.go — per-user direct message privacy (migration 070, WP 6.8b).
//
// Both routes key on the session user and there is no route that reads another
// user's settings. Sync across devices is by REST only, so nothing here is
// broadcast.

package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/J3vb/OwnCord/Server/service"
)

// privacyMaxBody bounds a privacy PUT body; the real body is under 100 bytes.
const privacyMaxBody = 1024

type privacyJSON struct {
	AllowMemberDMs  bool `json:"allow_member_dms"`
	MessageRequests bool `json:"message_requests"`
}

func handleGetPrivacy(privacy *service.PrivacyService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		p, err := privacy.Get(r.Context(), user.ID)
		if err != nil {
			slog.Error("get privacy", "error", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load privacy settings")
			return
		}
		writeJSON(w, http.StatusOK, privacyJSON{AllowMemberDMs: p.AllowMemberDMs, MessageRequests: p.MessageRequests})
	}
}

func handlePutPrivacy(privacy *service.PrivacyService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, privacyMaxBody)
		var in struct {
			AllowMemberDMs  *bool `json:"allow_member_dms"`
			MessageRequests *bool `json:"message_requests"`
		}
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		err := dec.Decode(&in)
		if err == nil && !errors.Is(dec.Decode(&struct{}{}), io.EOF) {
			err = errors.New("trailing data")
		}
		if err != nil || in.AllowMemberDMs == nil || in.MessageRequests == nil {
			writeErr(w, http.StatusBadRequest, "INVALID_INPUT", "invalid request body")
			return
		}
		p, err := privacy.Set(r.Context(), user.ID, service.Privacy{AllowMemberDMs: *in.AllowMemberDMs, MessageRequests: *in.MessageRequests})
		if err != nil {
			slog.Error("set privacy", "error", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not save privacy settings")
			return
		}
		writeJSON(w, http.StatusOK, privacyJSON{AllowMemberDMs: p.AllowMemberDMs, MessageRequests: p.MessageRequests})
	}
}
