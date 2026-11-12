// external_handler.go is the browser client's external-content broker. A browser tab has no native broker, so
// with the browser client hosted the server fetches link previews and outside images for it
// (Server/externalcontent), so the viewer's browser never contacts a host a message author chose.
// A refusal is a normal broker answer: both routes answer 200 with {"ok":false,"failure":"<name>"} using
// the names in Client/src/platform/contracts/externalContent.ts.

package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/externalcontent"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// newExternalBroker builds the broker the routes use. A var only so tests can
// hand the routes a broker that reaches a loopback stub.
var newExternalBroker = func() *externalcontent.Broker {
	return externalcontent.MustNew(externalcontent.DefaultPagePolicy, externalcontent.DefaultImagePolicy)
}

// externalImageMaxAge is how long the viewer's browser may reuse an image.
const externalImageMaxAge = time.Hour

type externalRefusal struct {
	OK      bool                    `json:"ok"`
	Failure externalcontent.Failure `json:"failure"`
}

type externalPreviewResult struct {
	OK    bool                    `json:"ok"`
	Value externalcontent.Preview `json:"value"`
}

// mountExternalContent mounts the broker routes when the server hosts the
// browser client, and nothing otherwise.
func mountExternalContent(r chi.Router, cfg *config.Config, sessions *service.SessionService, limiter *auth.RateLimiter) {
	if !cfg.Server.BrowserClientEnabled {
		return
	}
	MountExternalContentRoutes(r, sessions, limiter, cfg, newExternalBroker())
}

// MountExternalContentRoutes registers the authenticated broker endpoints on one per-IP bucket, looser than
// the GIF search's.
func MountExternalContentRoutes(r chi.Router, sessions *service.SessionService, limiter *auth.RateLimiter, cfg *config.Config, broker *externalcontent.Broker) {
	r.Route("/api/v1/external", func(r chi.Router) {
		r.Use(AuthMiddleware(sessions))
		r.Use(RateLimitMiddleware(limiter, "external:", externalRateLimitPerMinute, time.Minute, cfg.Server.TrustedProxies))
		r.Get("/preview", handleExternalPreview(broker))
		r.Get("/image", handleExternalImage(broker))
	})
}

func writeExternalRefusal(w http.ResponseWriter, f externalcontent.Failure) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, externalRefusal{OK: false, Failure: f})
}

func handleExternalPreview(broker *externalcontent.Broker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := currentUserID(r)
		if !ok {
			writeExternalRefusal(w, externalcontent.Unavailable)
			return
		}
		raw := r.URL.Query().Get("url")
		if raw == "" {
			writeExternalRefusal(w, externalcontent.BlockedDestination)
			return
		}
		preview, err := broker.Preview(r.Context(), userID, raw)
		if err != nil {
			writeExternalRefusal(w, externalcontent.FailureOf(err))
			return
		}
		// Handles are per viewer and expire, so the answer is never shared.
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, externalPreviewResult{OK: true, Value: preview})
	}
}

func handleExternalImage(broker *externalcontent.Broker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := currentUserID(r)
		if !ok {
			writeExternalRefusal(w, externalcontent.Unavailable)
			return
		}
		q := r.URL.Query()
		body, media, err := broker.Image(r.Context(), userID, q.Get("handle"), q.Get("url"))
		if err != nil {
			writeExternalRefusal(w, externalcontent.FailureOf(err))
			return
		}
		// A slow reader of a large image outlasts the global write timeout, so push it out on each chunk.
		deadlines := newTransferDeadline(w, r, int64(len(body)))
		defer deadlines.release()
		deadlines.touch()
		w = progressWriter{ResponseWriter: w, d: deadlines}
		h := w.Header()
		h.Set("Content-Type", media)
		h.Set("Content-Length", strconv.Itoa(len(body)))
		h.Set("Cache-Control", "private, max-age="+strconv.Itoa(int(externalImageMaxAge.Seconds())))
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body) //nolint:gosec // G705: sniffed raster bytes, served nosniff under a sandbox CSP
	}
}
