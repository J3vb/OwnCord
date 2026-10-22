package api

import (
	"net/http"

	"github.com/J3vb/OwnCord/Server/service"
)

// handleDeleteAvatar serves DELETE /api/v1/users/me/avatar: clear the caller's
// avatar. It does what PATCH {"avatar":""} does without sending a username
// snapshot, so a concurrent rename on another device is not reverted
// (UpdateProfile treats an empty Username as "leave it alone"). Idempotent: a
// caller with no avatar still gets 200 with their user. The old file's bytes
// are left for the operator sweep, as on replace.
func handleDeleteAvatar(svc *service.Services, broadcaster ProfileBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		cleared := ""
		updated, err := svc.Users.UpdateProfile(r.Context(), user.ID, service.ProfilePatch{Avatar: &cleared})
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		broadcastUserUpdate(broadcaster, updated)
		writeJSON(w, http.StatusOK, toUserResponse(updated))
	}
}
