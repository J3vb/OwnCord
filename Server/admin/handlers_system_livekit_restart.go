package admin

import (
	"context"
	"net/http"

	"github.com/J3vb/OwnCord/Server/httperr"
)

// liveKitRestarter wakes the supervised companion after its quick restarts ran
// out (the Hub). A hub without it, or with an external LiveKit, has nothing to
// restart.
type liveKitRestarter interface {
	LiveKitManaged() bool
	RestartLiveKit() bool
}

// voiceRestartAuditor records an accepted press (service.DiagnosticsService).
type voiceRestartAuditor interface {
	RecordVoiceServerRestart(ctx context.Context, actor int64)
}

// handleRestartLiveKit is POST /system/livekit/restart: the System health
// page's "Restart voice server" button, gated like POST /restart. It only
// wakes a supervisor that stopped its quick restarts, so it can never kill a
// running voice server.
func handleRestartLiveKit(audit voiceRestartAuditor, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		lk, ok := hub.(liveKitRestarter)
		if !ok || !lk.LiveKitManaged() {
			writeErr(w, http.StatusConflict, httperr.CodeConflict, "LiveKit runs on its own; restart it where it runs.")
			return
		}
		if !lk.RestartLiveKit() {
			writeErr(w, http.StatusConflict, httperr.CodeConflict, "The voice server has not stopped restarting, so there is nothing to restart.")
			return
		}
		audit.RecordVoiceServerRestart(context.WithoutCancel(r.Context()), actorFromContext(r))
		writeJSON(w, http.StatusAccepted, map[string]bool{"restarting": true})
	}
}
