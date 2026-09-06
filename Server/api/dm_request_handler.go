package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
)

// MountDMRequestRoutes registers the message-request inbox and its four
// recipient-only transitions (B5-6). All routes require authentication.
// broadcaster is used to send real-time dm_channel_open (on accept) and
// dm_request (every transition) events to the recipient's other devices —
// the same DMBroadcaster seam MountDMRoutes uses.
func MountDMRequestRoutes(r chi.Router, svc *service.Services, broadcaster DMBroadcaster) {
	r.Route("/api/v1/dm-requests", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Get("/", handleListDMRequests(svc))
		r.Post("/{id}/accept", handleDMRequestTransition(svc, broadcaster, dmRequestActionAccept))
		r.Post("/{id}/ignore", handleDMRequestTransition(svc, broadcaster, dmRequestActionIgnore))
		r.Post("/{id}/delete", handleDMRequestTransition(svc, broadcaster, dmRequestActionDelete))
		r.Post("/{id}/block", handleDMRequestTransition(svc, broadcaster, dmRequestActionBlock))
	})
}

type dmRequestAction int

const (
	dmRequestActionAccept dmRequestAction = iota
	dmRequestActionIgnore
	dmRequestActionDelete
	dmRequestActionBlock
)

// dmRequestSenderResponse mirrors ws's dmRequestSenderPayload — the two are
// independent (api and ws build their own wire shapes, like dm_handler.go's
// response types and ws/messages.go's dm_channel_open builder) but must stay
// in step with docs/protocol.md's dm_request section.
type dmRequestSenderResponse struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Avatar      string `json:"avatar"`
}

type dmRequestPreviewResponse struct {
	MessageID int64  `json:"message_id"`
	Content   string `json:"content"`
	Timestamp string `json:"timestamp"`
}

type dmRequestListItem struct {
	ID        int64                     `json:"id"`
	ChannelID int64                     `json:"channel_id"`
	Sender    dmRequestSenderResponse   `json:"sender"`
	Preview   *dmRequestPreviewResponse `json:"preview"`
	CreatedAt string                    `json:"created_at"`
}

// handleListDMRequests handles GET /api/v1/dm-requests: the caller's pending
// inbox, newest first.
func handleListDMRequests(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "authentication required"})
			return
		}

		reqs, err := svc.MessageRequests.ListPending(r.Context(), user.ID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		out := make([]dmRequestListItem, 0, len(reqs))
		for i := range reqs {
			rq := &reqs[i]
			item := dmRequestListItem{
				ID:        rq.ID,
				ChannelID: rq.ChannelID,
				Sender: dmRequestSenderResponse{
					ID: rq.SenderID, Username: rq.SenderUsername,
					DisplayName: rq.SenderDisplayName, Avatar: rq.SenderAvatar,
				},
				CreatedAt: rq.CreatedAt,
			}
			if rq.PreviewMessageID != 0 {
				item.Preview = &dmRequestPreviewResponse{
					MessageID: rq.PreviewMessageID, Content: rq.PreviewContent, Timestamp: rq.PreviewTimestamp,
				}
			}
			out = append(out, item)
		}
		writeJSON(w, http.StatusOK, map[string]any{"requests": out})
	}
}

// dmRequestTransitionResponse is the 200 body for every transition route.
type dmRequestTransitionResponse struct {
	ID        int64   `json:"id"`
	State     string  `json:"state"`
	DecidedAt *string `json:"decided_at"`
}

// handleDMRequestTransition handles the four POST .../{id}/<verb> routes.
// Every transition sends the recipient's other devices a dm_request frame
// with the new state (Preview nil — the message never changes); accept also
// sends dm_channel_open, since only acceptance opens the conversation.
func handleDMRequestTransition(svc *service.Services, broadcaster DMBroadcaster, action dmRequestAction) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "authentication required"})
			return
		}
		id, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}

		var (
			req *db.MessageRequest
			err error
		)
		switch action {
		case dmRequestActionAccept:
			req, err = svc.MessageRequests.Accept(r.Context(), user.ID, id)
		case dmRequestActionIgnore:
			req, err = svc.MessageRequests.Ignore(r.Context(), user.ID, id)
		case dmRequestActionDelete:
			req, err = svc.MessageRequests.Delete(r.Context(), user.ID, id)
		case dmRequestActionBlock:
			req, err = svc.MessageRequests.Block(r.Context(), user.ID, id)
		}
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		notifyDMRequestTransition(r.Context(), svc, broadcaster, user.ID, req, action == dmRequestActionAccept)

		writeJSON(w, http.StatusOK, dmRequestTransitionResponse{ID: req.ID, State: req.State, DecidedAt: req.DecidedAt})
	}
}

// notifyDMRequestTransition sends the recipient (userID, the caller who just
// decided) every event a transition owes their other devices: dm_channel_open
// on acceptance only (broadcastDMOpen, dm_handler.go's existing builder),
// then dm_request with the new state and no preview, always. Best-effort and
// detached from the request context — the transition already committed, so a
// caller whose connection drops right after must not silently drop it.
func notifyDMRequestTransition(ctx context.Context, svc *service.Services, broadcaster DMBroadcaster, userID int64, req *db.MessageRequest, opened bool) {
	if broadcaster == nil {
		return
	}
	bgCtx := context.WithoutCancel(ctx)

	if opened {
		broadcastDMOpen(bgCtx, svc, broadcaster, req.ChannelID, []int64{userID})
	}

	sender, err := svc.Users.Get(bgCtx, req.SenderID)
	if err != nil || sender == nil {
		slog.Warn("notifyDMRequestTransition: sender lookup failed, dropping the dm_request push",
			"err", err, "request_id", req.ID, "sender_id", req.SenderID)
		return
	}
	avatar := ""
	if sender.Avatar != nil {
		avatar = *sender.Avatar
	}
	displayName := ""
	if sender.DisplayName != nil {
		displayName = *sender.DisplayName
	}
	payload, err := json.Marshal(map[string]any{
		"type": ws.MsgTypeDMRequest,
		"payload": map[string]any{
			"id":         req.ID,
			"state":      req.State,
			"channel_id": req.ChannelID,
			"sender": map[string]any{
				"id": sender.ID, "username": sender.Username,
				"display_name": displayName, "avatar": avatar,
			},
			"preview":    nil,
			"created_at": req.CreatedAt,
			"decided_at": req.DecidedAt,
		},
	})
	if err != nil {
		slog.Warn("notifyDMRequestTransition: marshal failed", "err", err, "request_id", req.ID)
		return
	}
	if ok := broadcaster.SendToUser(userID, payload); !ok {
		slog.Debug("notifyDMRequestTransition: user not connected", "user_id", userID, "request_id", req.ID)
	}
}
