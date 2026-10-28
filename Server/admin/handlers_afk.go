package admin

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/J3vb/OwnCord/Server/service"
)

// afkChannelRequest is the JSON body for PUT /admin/api/afk-channel.
// channel_id must be present: a number flags that channel as the AFK channel,
// an explicit null clears the flag. An absent key is a bad request rather than
// a silent clear.
type afkChannelRequest struct {
	ChannelID json.RawMessage `json:"channel_id"`
}

// afkChannelResponse echoes the flag's new owner (null when cleared).
type afkChannelResponse struct {
	ChannelID *int64 `json:"channel_id"`
}

// voicePermissionReconciler is implemented by the hub. It is asserted rather
// than added to HubBroadcaster so the many HubBroadcaster test doubles stay
// as they are.
type voicePermissionReconciler interface {
	ReconcileChannelVoicePermissions(channelID int64)
}

// handlePutAFKChannel serves PUT /admin/api/afk-channel (MANAGE_SERVER). The
// service validates the channel and commits the swap in one transaction; the
// handler then tells connected clients about both channels whose flag moved.
func handlePutAFKChannel(channels *service.ChannelService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if channels == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "channel service unavailable")
			return
		}
		var req afkChannelRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		if len(req.ChannelID) == 0 {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "channel_id is required (a channel id, or null to clear)")
			return
		}
		var channelID *int64
		if !bytes.Equal(bytes.TrimSpace(req.ChannelID), []byte("null")) {
			var id int64
			if err := json.Unmarshal(req.ChannelID, &id); err != nil {
				writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "channel_id must be a channel id or null")
				return
			}
			channelID = &id
		}

		change, err := channels.SetAFKChannel(r.Context(), actorFromContext(r), channelID)
		if err != nil {
			writeChannelErr(w, err)
			return
		}
		if hub != nil {
			if change.Previous != nil {
				hub.BroadcastChannelUpdate(change.Previous)
			}
			if change.Current != nil {
				hub.BroadcastChannelUpdate(change.Current)
			}
			if rec, ok := hub.(voicePermissionReconciler); ok {
				if change.Previous != nil {
					rec.ReconcileChannelVoicePermissions(change.Previous.ID)
				}
				if change.Current != nil {
					rec.ReconcileChannelVoicePermissions(change.Current.ID)
				}
			}
		}
		writeJSON(w, http.StatusOK, afkChannelResponse{ChannelID: channelID})
	}
}
