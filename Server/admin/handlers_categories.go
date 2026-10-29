package admin

import (
	"errors"
	"net/http"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

// ─── Channel category handlers (WP 6.5a) ─────────────────────────────────────
//
// Thin adapters over service.ChannelService's category operations, mounted by
// mountChannelActionRoutes behind MANAGE_CHANNELS on both channel mounts. A
// mutation answers from the committed row, then tells connected clients:
// channel_update for every channel whose category fields changed (through the
// ordinary visibility-filtered path, so a non-manager only hears about
// channels they can read), then channel_categories to managers.

// writeCategoryErr maps ChannelService category errors onto API responses.
// A duplicate name and a stale reorder are both 409 with distinct codes.
func writeCategoryErr(w http.ResponseWriter, err error, staleCode httperr.Code) {
	if errors.Is(err, service.ErrConflict) {
		code := httperr.CodeCategoryNameTaken
		if staleCode != "" {
			code = staleCode
		}
		writeErr(w, http.StatusConflict, code, err.Error())
		return
	}
	writeSvcErr(w, err, "category not found", httperr.CodeInvalidInput, "category action failed")
}

// announceCategoryChange fans a committed category change out: first the
// re-broadcast channel_update for each channel whose category fields moved,
// then the manager-only category list.
func announceCategoryChange(hub HubBroadcaster, change service.CategoryChange) {
	if hub == nil {
		return
	}
	for i := range change.Channels {
		hub.BroadcastChannelUpdate(&change.Channels[i])
	}
	hub.BroadcastChannelCategories(change.Categories)
}

func handleListCategories(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if channels == nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "channel service unavailable")
			return
		}
		cats, err := channels.ListCategories(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to list categories")
			return
		}
		writeJSON(w, http.StatusOK, cats)
	}
}

type categoryNameRequest struct {
	Name string `json:"name"`
}

func handleCreateCategory(channels *service.ChannelService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if channels == nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "channel service unavailable")
			return
		}
		var req categoryNameRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		change, err := channels.CreateCategory(r.Context(), actorFromContext(r), req.Name)
		if err != nil {
			writeCategoryErr(w, err, "")
			return
		}
		announceCategoryChange(hub, change)
		writeJSON(w, http.StatusCreated, change.Category)
	}
}

func handleRenameCategory(channels *service.ChannelService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if channels == nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "channel service unavailable")
			return
		}
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid category id")
			return
		}
		var req categoryNameRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		change, err := channels.RenameCategory(r.Context(), actorFromContext(r), id, req.Name)
		if err != nil {
			writeCategoryErr(w, err, "")
			return
		}
		announceCategoryChange(hub, change)
		writeJSON(w, http.StatusOK, change.Category)
	}
}

type categoryOrderRequest struct {
	IDs []int64 `json:"ids"`
}

func handleReorderCategories(channels *service.ChannelService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if channels == nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "channel service unavailable")
			return
		}
		var req categoryOrderRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		if req.IDs == nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid request body")
			return
		}
		change, err := channels.ReorderCategories(r.Context(), actorFromContext(r), req.IDs)
		if err != nil {
			writeCategoryErr(w, err, httperr.CodeCategoryListStale)
			return
		}
		announceCategoryChange(hub, change)
		writeJSON(w, http.StatusOK, change.Categories)
	}
}

func handleDeleteCategory(channels *service.ChannelService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if channels == nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "channel service unavailable")
			return
		}
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid category id")
			return
		}
		change, err := channels.DeleteCategory(r.Context(), actorFromContext(r), id)
		if err != nil {
			writeCategoryErr(w, err, "")
			return
		}
		announceCategoryChange(hub, change)
		w.WriteHeader(http.StatusNoContent)
	}
}
