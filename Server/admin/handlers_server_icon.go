package admin

import (
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

// serverIconReply is the PUT /server-icon answer: the hash clients and the panel compare.
type serverIconReply struct {
	Icon string `json:"icon"`
}

// handlePutServerIcon stores the request body (a PNG, at most service.ServerIconMaxBytes) as the server icon.
func handlePutServerIcon(settings *service.SettingsService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if settings == nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "settings service unavailable")
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, service.ServerIconMaxBytes))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "server icon must be at most 64 KiB")
				return
			}
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "could not read the request body")
			return
		}
		hash, err := settings.SetServerIcon(r.Context(), actorFromContext(r), body)
		if err != nil {
			writeServerIconErr(w, r, err)
			return
		}
		expireHubSettingsCache(hub)
		writeJSON(w, http.StatusOK, serverIconReply{Icon: hash})
	}
}

// handleDeleteServerIcon removes the server icon; removing none is a success.
func handleDeleteServerIcon(settings *service.SettingsService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if settings == nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "settings service unavailable")
			return
		}
		if err := settings.ClearServerIcon(r.Context(), actorFromContext(r)); err != nil {
			writeServerIconErr(w, r, err)
			return
		}
		expireHubSettingsCache(hub)
		writeJSON(w, http.StatusOK, serverIconReply{Icon: ""})
	}
}

func writeServerIconErr(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, service.ErrBadRequest) {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, err.Error())
		return
	}
	slog.ErrorContext(r.Context(), "settings patch failed", "route", "server-icon", "error", err)
	writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to update the server icon")
}
