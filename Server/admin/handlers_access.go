package admin

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/J3vb/OwnCord/Server/service"
)

// ─── Access explanation and override preview (RI-06) ─────────────────────────
//
// Read-only adapters over service.ChannelService: the decision comes from the
// canonical predicates on the server, never from the panel, and no request
// here acts as the member it asks about. Both reads are audited in the service.

func handleExplainAccess(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch := resolveGuildChannel(channels, w, r)
		if ch == nil {
			return
		}
		userID, err := strconv.ParseInt(r.URL.Query().Get("user_id"), 10, 64)
		if err != nil || userID <= 0 {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid user id")
			return
		}
		res, err := channels.ExplainAccess(r.Context(), actorFromContext(r), userID, ch, r.URL.Query().Get("action"))
		if err != nil {
			writeSvcErr(w, err, "", "", "failed to explain access")
			return
		}
		writeJSON(w, http.StatusOK, res)
	}
}

// previewAccessRequest is the proposed override: exactly one of RoleID
// (the role layer) or UserID (the member layer), with the masks PUT would take.
type previewAccessRequest struct {
	RoleID int64 `json:"role_id"`
	UserID int64 `json:"user_id"`
	Allow  int64 `json:"allow"`
	Deny   int64 `json:"deny"`
}

func handlePreviewAccess(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch := resolveGuildChannel(channels, w, r)
		if ch == nil {
			return
		}
		var req previewAccessRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.RoleID < 0 || req.UserID < 0 {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}
		res, err := channels.PreviewOverride(r.Context(), actorFromContext(r), ch, req.RoleID, req.UserID, req.Allow, req.Deny)
		if err != nil {
			writeSvcErr(w, err, "", "", "failed to preview access")
			return
		}
		writeJSON(w, http.StatusOK, res)
	}
}
