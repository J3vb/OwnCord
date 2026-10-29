package admin

import (
	"context"
	"errors"
	"math"
	"net/http"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

// ─── Registration queue (approval mode) ────────────────────────────────
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
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to list pending registrations")
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
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid registration id")
			return
		}
		err = decide(r.Context(), actorFromContext(r), id)
		if errors.Is(err, service.ErrNotFound) {
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "no pending registration with that id")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to decide the registration")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
