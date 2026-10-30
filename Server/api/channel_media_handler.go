package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// MountChannelMediaRoutes registers a channel's media gallery: one page of its
// attachments and the per-month counts behind the month scrubber. Both share
// the media rate-limit bucket, since scrolling the gallery pages quickly.
func MountChannelMediaRoutes(r chi.Router, svc *service.Services, limiter *auth.RateLimiter, trustedProxies []string) {
	gated := r.With(
		AuthMiddleware(svc.Sessions),
		RateLimitMiddleware(limiter, "media:", mediaRateLimitPerMinute, time.Minute, trustedProxies),
	)
	gated.Get("/api/v1/channels/{id}/media", handleListChannelMedia(svc))
	gated.Get("/api/v1/channels/{id}/media/months", handleChannelMediaMonths(svc))
}

func handleListChannelMedia(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID, user, in, ok := parseChannelMediaRequest(w, r)
		if !ok {
			return
		}
		page, err := svc.Messages.ListChannelMedia(r.Context(), user, channelID, in)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, page)
	}
}

func handleChannelMediaMonths(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID, user, in, ok := parseChannelMediaRequest(w, r)
		if !ok {
			return
		}
		months, err := svc.Messages.ChannelMediaMonths(r.Context(), user, channelID, in)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, struct {
			Months []service.MediaMonth `json:"months"`
		}{months})
	}
}

// parseChannelMediaRequest reads the path id, the caller and the query
// parameters both gallery routes take. Value checks that need no request
// (kind, q length, month, tz, cursor) live in the service.
func parseChannelMediaRequest(w http.ResponseWriter, r *http.Request) (channelID, userID int64, in service.ChannelMediaRequest, ok bool) {
	channelID, ok = parseIDParam(w, r, "id")
	if !ok {
		return 0, 0, in, false
	}
	user, ok := requireUser(w, r)
	if !ok {
		return 0, 0, in, false
	}
	q := r.URL.Query()
	in = service.ChannelMediaRequest{
		Kind:   q.Get("kind"),
		Name:   q.Get("q"),
		Month:  q.Get("month"),
		TZ:     q.Get("tz"),
		Cursor: q.Get("cursor"),
	}
	switch q.Get("order") {
	case "", "newest":
	case "oldest":
		in.Oldest = true
	default:
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "order must be newest or oldest")
		return 0, 0, in, false
	}
	if raw := q.Get("from"); raw != "" {
		v, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || v < 1 {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "from must be a positive user id")
			return 0, 0, in, false
		}
		in.UploaderID = v
	}
	if raw := q.Get("limit"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 1 {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "limit must be a positive integer")
			return 0, 0, in, false
		}
		in.Limit = v
	}
	return channelID, user.ID, in, true
}
