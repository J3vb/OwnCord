// user_note_handler.go — private per-user profile notes (migration 069, WP 6.11a).
//
// A note is private to its owner: both routes key on the session user and
// there is no route that reads another user's notes. Sync across devices is by
// REST only, so nothing here is broadcast.

package api

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/J3vb/OwnCord/Server/service"
)

type userNoteJSON struct {
	UserID int64  `json:"user_id"`
	Note   string `json:"note"`
}

// parseNoteTarget reads the {userId} path parameter.
func parseNoteTarget(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "userId"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "INVALID_INPUT", "invalid user id")
		return 0, false
	}
	return id, true
}

func handleGetUserNote(notes *service.UserNoteService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		target, ok := parseNoteTarget(w, r)
		if !ok {
			return
		}
		note, err := notes.Get(r.Context(), user.ID, target)
		if err != nil {
			slog.Error("get user note", "error", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load note")
			return
		}
		writeJSON(w, http.StatusOK, userNoteJSON{UserID: target, Note: note})
	}
}

func handlePutUserNote(notes *service.UserNoteService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		target, ok := parseNoteTarget(w, r)
		if !ok {
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, userNoteMaxBody)
		var in struct {
			Note *string `json:"note"`
		}
		if !decodeJSON(w, r, &in) {
			return
		}
		if in.Note == nil {
			writeErr(w, http.StatusBadRequest, "INVALID_INPUT", "invalid request body")
			return
		}
		note, err := notes.Put(r.Context(), user.ID, target, *in.Note)
		switch {
		case errors.Is(err, service.ErrBadRequest):
			writeErr(w, http.StatusBadRequest, "INVALID_INPUT", fmt.Sprintf("note must be at most %d characters", maxUserNoteLen))
			return
		case errors.Is(err, service.ErrNotFound):
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "user not found")
			return
		case err != nil:
			slog.Error("put user note", "error", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not save note")
			return
		}
		writeJSON(w, http.StatusOK, userNoteJSON{UserID: target, Note: note})
	}
}
