package admin

import (
	"context"
	"net/http"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
)

// liveKitRestarter wakes the supervised companion after its quick restarts ran
// out (the Hub). A hub without it, or with an external LiveKit, has nothing to
// restart.
type liveKitRestarter interface {
	LiveKitManaged() bool
	RestartLiveKit() bool
}

// handleRestartLiveKit is POST /system/livekit/restart: the System health
// page's "Restart voice server" button. It only wakes a supervisor that stopped
// its quick restarts, so it can never kill a running voice server.
func handleRestartLiveKit(database *db.DB, hub HubBroadcaster) http.HandlerFunc {
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
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actorFromContext(r), "voice_server_restart_requested", "server", 0, "manual")
		writeJSON(w, http.StatusAccepted, map[string]bool{"restarting": true})
	}
}
