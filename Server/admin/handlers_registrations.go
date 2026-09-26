package admin

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/J3vb/OwnCord/Server/service"
)

// ─── Registration queue (B4-1, approval mode) ────────────────────────────────
//
// An approval-mode application is an account row that cannot sign in until
// an admin approves it; denial deletes it. Both decisions are audited by the
// service (registration_approve / registration_deny).

type pendingRegistrationResponse struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	CreatedAt string `json:"created_at"`
}

func handleListRegistrations(users *service.UserService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := queryInt(r, "limit", 50, 1, 500)
		offset := queryInt(r, "offset", 0, 0, math.MaxInt32)

		pending, err := users.ListPendingRegistrations(r.Context(), limit, offset)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list pending registrations")
			return
		}
		out := make([]pendingRegistrationResponse, len(pending))
		for i, p := range pending {
			out[i] = pendingRegistrationResponse{ID: p.ID, Username: p.Username, CreatedAt: p.CreatedAt}
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func handleApproveRegistration(users *service.UserService) http.HandlerFunc {
	return decideRegistration(users.ApproveRegistration)
}

func handleDenyRegistration(users *service.UserService) http.HandlerFunc {
	return decideRegistration(users.DenyRegistration)
}

func decideRegistration(decide func(ctx context.Context, actorID, userID int64) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil || id <= 0 {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid registration id")
			return
		}
		err = decide(r.Context(), actorFromContext(r), id)
		if errors.Is(err, service.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "no pending registration with that id")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to decide the registration")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
