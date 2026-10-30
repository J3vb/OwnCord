package admin

import (
	"net/http"

	"github.com/J3vb/OwnCord/Server/service"
)

//
// PUT /{id}/forum under mountChannelActionRoutes, so it is served under both
// /admin/api/channels and /api/v1/moderation/channels behind MANAGE_CHANNELS.
// The body is the whole forum settings; see service.AdminUpdateForumSettings.

// forumTagRequest is one tag of a forum settings body. A tag without an id is
// created; a listed id is renamed, re-emojied and repositioned (its position
// is its place in the list). A tag of the forum missing from the list is
// deleted.
type forumTagRequest struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Emoji string `json:"emoji"`
}

// forumSettingsRequest is the JSON body for PUT /admin/api/channels/{id}/forum.
type forumSettingsRequest struct {
	Tags                      []forumTagRequest `json:"tags"`
	RequireTag                bool              `json:"require_tag"`
	DefaultAutoArchiveMinutes int               `json:"default_auto_archive_minutes"`
}

func handlePutForumSettings(channels *service.ChannelService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		existing := resolveGuildChannel(channels, w, r)
		if existing == nil {
			return
		}
		var req forumSettingsRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		in := service.ForumSettingsInput{
			RequireTag:                req.RequireTag,
			DefaultAutoArchiveMinutes: req.DefaultAutoArchiveMinutes,
			Tags:                      make([]service.ForumTagInput, 0, len(req.Tags)),
		}
		for i := range req.Tags {
			in.Tags = append(in.Tags, service.ForumTagInput{ID: req.Tags[i].ID, Name: req.Tags[i].Name, Emoji: req.Tags[i].Emoji})
		}
		updated, err := channels.AdminUpdateForumSettings(r.Context(), actorFromContext(r), existing, in)
		if err != nil {
			writeChannelErr(w, err)
			return
		}
		if hub != nil {
			hub.BroadcastChannelUpdate(updated)
		}
		writeJSON(w, http.StatusOK, updated)
	}
}
