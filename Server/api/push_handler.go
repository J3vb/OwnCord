// push_handler.go — Web Push subscription STORAGE endpoints (B5-4).
//
// Nothing here dispatches a push notification anywhere; that is B5-11,
// behind HP-5. This file only lets a signed-in user register, list and
// revoke their own subscriptions, and hands back the server's VAPID public
// key so the client can create one in the first place.
//
// Default-off contract, mirroring gif_handler.go: routes are always
// mounted, but with push.enabled false every one answers 503 PUSH_DISABLED,
// checked by a dedicated middleware that runs AFTER session auth and BEFORE
// any handler reads the request body — so a disabled server authenticates
// the caller (a probe cannot use this surface to test credentials for
// free), then refuses before doing anything else.

package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// pushSubscribeMaxBodySize bounds the subscribe body well below the
// router-wide default (defaultMaxBodySize, 1 MiB): a subscription is an
// endpoint URL, two short base64 secrets and a device label.
const pushSubscribeMaxBodySize = 8 << 10 // 8 KiB

// MountPushRoutes registers the /api/v1/push endpoints. sessions gates
// authentication the same way every other authenticated REST surface does;
// enabled is cfg.Push.Enabled at mount time (the routes never move — flip
// the config key and restart to change behaviour, same as GIF and browser
// hosting).
func MountPushRoutes(r chi.Router, sessions *service.SessionService, push *service.PushService, enabled bool) {
	r.Route("/api/v1/push", func(r chi.Router) {
		r.Use(AuthMiddleware(sessions))
		r.Use(pushDisabledMiddleware(enabled))

		r.Get("/vapid", handlePushVAPID(push))
		r.Get("/subscriptions", handleListPushSubscriptions(push))
		r.With(MaxBodySize(pushSubscribeMaxBodySize)).Post("/subscriptions", handleSubscribePush(push))
		r.Delete("/subscriptions/{id}", handleRevokePushSubscription(push))
	})
}

// pushDisabledMiddleware answers every push route 503 PUSH_DISABLED without
// touching the request body when enabled is false. It sits inside
// AuthMiddleware (mounted after it in MountPushRoutes), so a disabled
// server still requires a valid session before refusing — a probe cannot
// use this surface to test credentials against a server that has push off.
func pushDisabledMiddleware(enabled bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if enabled {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusServiceUnavailable, errorResponse{
				Error:   "PUSH_DISABLED",
				Message: "Web Push is not enabled on this server",
			})
		})
	}
}

// pushVAPIDResponse is GET /api/v1/push/vapid's body.
type pushVAPIDResponse struct {
	PublicKey string `json:"public_key"`
	KeyID     string `json:"key_id"`
}

// handlePushVAPID reports the running key so a client can create a
// subscription and detect a rotation later (a mismatched key_id on a
// refresh means "re-subscribe").
func handlePushVAPID(push *service.PushService) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		pub, keyID, ok := push.PublicKey()
		if !ok {
			writeJSON(w, http.StatusServiceUnavailable, errorResponse{
				Error: "PUSH_DISABLED", Message: "no VAPID key is installed",
			})
			return
		}
		writeJSON(w, http.StatusOK, pushVAPIDResponse{PublicKey: pub, KeyID: keyID})
	}
}

// pushSubscriptionResponse is one row of GET /api/v1/push/subscriptions —
// never the endpoint (a push credential), never the keys.
type pushSubscriptionResponse struct {
	ID           int64  `json:"id"`
	DeviceName   string `json:"device_name"`
	EndpointHost string `json:"endpoint_host"`
	CreatedAt    string `json:"created_at"`
	LastSeenAt   string `json:"last_seen_at"`
}

type pushSubscriptionsListResponse struct {
	Subscriptions []pushSubscriptionResponse `json:"subscriptions"`
}

func handleListPushSubscriptions(push *service.PushService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		rows, err := push.List(r.Context(), user.ID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		resp := pushSubscriptionsListResponse{Subscriptions: make([]pushSubscriptionResponse, 0, len(rows))}
		for _, row := range rows {
			resp.Subscriptions = append(resp.Subscriptions, pushSubscriptionResponse{
				ID:           row.ID,
				DeviceName:   row.DeviceName,
				EndpointHost: endpointHost(row.Endpoint),
				CreatedAt:    row.CreatedAt.UTC().Format(time.RFC3339),
				LastSeenAt:   row.LastSeenAt.UTC().Format(time.RFC3339),
			})
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// endpointHost extracts only the host of a push endpoint URL. The endpoint
// itself is a push credential and must never reach a listing response;
// the host is enough for a user to recognise which push service a device
// uses.
func endpointHost(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err != nil {
		return ""
	}
	return u.Host
}

// pushSubscribeRequest is POST /api/v1/push/subscriptions' body — the shape
// a browser's PushSubscription.toJSON() produces. There is no user id here
// on purpose: the row's owner is always the authenticated session's.
type pushSubscribeRequest struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
	DeviceName string `json:"device_name"`
}

type pushSubscribeResponse struct {
	ID int64 `json:"id"`
}

func handleSubscribePush(push *service.PushService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		var req pushSubscribeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "INVALID_INPUT", Message: "malformed request body"})
			return
		}
		id, err := push.Subscribe(r.Context(), user.ID, service.PushSubscribeInput{
			Endpoint:   req.Endpoint,
			P256dh:     req.Keys.P256dh,
			Auth:       req.Keys.Auth,
			DeviceName: req.DeviceName,
		})
		if err != nil {
			if errors.Is(err, service.ErrInvalidSubscription) {
				writeJSON(w, http.StatusBadRequest, errorResponse{Error: "INVALID_INPUT", Message: err.Error()})
				return
			}
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusCreated, pushSubscribeResponse{ID: id})
	}
}

func handleRevokePushSubscription(push *service.PushService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		id, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}
		if err := push.Revoke(r.Context(), user.ID, id); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
