package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
)

// MountNSFWRoutes registers the per-user NSFW acknowledgement toggle (B5-7)
// under /api/v1/channels/{id}/nsfw-acknowledgement. broadcaster sends the
// caller's OTHER live sockets an nsfw_ack frame so a second device converges
// without a reconnect — the same DMBroadcaster seam MountDMRoutes uses.
func MountNSFWRoutes(r chi.Router, svc *service.Services, broadcaster DMBroadcaster) {
	r.Route("/api/v1/channels/{id}/nsfw-acknowledgement", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Put("/", handleNSFWAcknowledge(svc, broadcaster))
		r.Delete("/", handleNSFWRevoke(svc, broadcaster))
	})
}

// nsfwPostBumpPreNotifyHook, when non-nil, runs once per acknowledge/revoke
// immediately after the visibility watermark bumps and before the
// best-effort notify send (Codex round 2, P2). Test-only (always nil in
// production): lets a test observe the exact point at which a concurrently
// registering socket is already guaranteed to see the fresh state,
// regardless of whether the notify frame itself ever arrives.
var nsfwPostBumpPreNotifyHook func()

func handleNSFWAcknowledge(svc *service.Services, broadcaster DMBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, channelID, ok := nsfwRequestParams(w, r)
		if !ok {
			return
		}
		if err := svc.NSFW.Acknowledge(r.Context(), user.ID, channelID); err != nil {
			writeNSFWError(r.Context(), w, err)
			return
		}
		// P2-8 / Codex round 2 P2: bump BEFORE the notify send, same ordering
		// broadcastDMOpen uses relative to its SendToUser calls. nsfw_ack is
		// unsequenced and not replayed (protocol/schema.json's own note), so
		// the bump — not the frame — is what makes a resume safe; a socket
		// that registers in the gap between these two calls must still land
		// on the full-ready path, not fall through a window where neither
		// the frame nor a forced resync can reach it.
		markDMVisibilityChanged(broadcaster)
		if nsfwPostBumpPreNotifyHook != nil {
			nsfwPostBumpPreNotifyHook()
		}
		notifyNSFWAck(broadcaster, user.ID, channelID, true)
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleNSFWRevoke(svc *service.Services, broadcaster DMBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, channelID, ok := nsfwRequestParams(w, r)
		if !ok {
			return
		}
		if err := svc.NSFW.Revoke(r.Context(), user.ID, channelID); err != nil {
			writeNSFWError(r.Context(), w, err)
			return
		}
		// P2-8 / Codex round 2 P2: see the matching comment in handleNSFWAcknowledge.
		markDMVisibilityChanged(broadcaster)
		if nsfwPostBumpPreNotifyHook != nil {
			nsfwPostBumpPreNotifyHook()
		}
		notifyNSFWAck(broadcaster, user.ID, channelID, false)
		w.WriteHeader(http.StatusNoContent)
	}
}

// nsfwRequestParams reads the authenticated caller and the {id} path
// parameter shared by both routes.
func nsfwRequestParams(w http.ResponseWriter, r *http.Request) (*db.User, int64, bool) {
	user, ok := r.Context().Value(UserKey).(*db.User)
	if !ok || user == nil {
		writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "authentication required"})
		return nil, 0, false
	}
	channelID, ok := parseIDParam(w, r, "id")
	if !ok {
		return nil, 0, false
	}
	return user, channelID, true
}

// writeNSFWError maps NSFWService's refusals: ErrNotNSFW gets its own 409
// NOT_NSFW code (distinct from the generic CONFLICT writeServiceError would
// otherwise answer with); everything else goes through the shared mapper.
func writeNSFWError(ctx context.Context, w http.ResponseWriter, err error) {
	if errors.Is(err, service.ErrNotNSFW) {
		writeJSON(w, http.StatusConflict, errorResponse{Error: "NOT_NSFW", Message: err.Error()})
		return
	}
	writeServiceError(ctx, w, err)
}

// notifyNSFWAck sends the caller's other live sockets an nsfw_ack frame so a
// second device updates without a reconnect. Best-effort: a disconnected
// broadcaster or an offline caller is not an error, matching
// notifyDMRequestTransition's posture.
func notifyNSFWAck(broadcaster DMBroadcaster, userID, channelID int64, acknowledged bool) {
	if broadcaster == nil {
		return
	}
	payload, err := json.Marshal(map[string]any{
		"type": ws.MsgTypeNSFWAck,
		"payload": map[string]any{
			"channel_id":   channelID,
			"acknowledged": acknowledged,
		},
	})
	if err != nil {
		slog.Warn("notifyNSFWAck: marshal failed", "err", err, "channel_id", channelID)
		return
	}
	if ok := broadcaster.SendToUser(userID, payload); !ok {
		slog.Debug("notifyNSFWAck: user not connected", "user_id", userID, "channel_id", channelID)
	}
}
