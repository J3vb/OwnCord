// gif_handler.go — server-side proxy for the Klipy GIF API.
//
// The Klipy API key lives in server config and never leaves the server: the
// client asks its own server for GIFs and the server does the upstream call.
// This closes the "secret in the client bundle" hole — a VITE_ variable is
// inlined into the shipped bundle by design and can never hold a credential.
//
// Default-off contract: with no gif.api_key configured both endpoints answer
// 503 with error code GIF_DISABLED, which the client uses to hide/disable the
// GIF picker instead of showing a broken one.

package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/go-chi/chi/v5"
)

// gifAPIBase is the upstream Klipy API root. It is a var only so tests can
// point it at a local stub; production never reassigns it.
var gifAPIBase = "https://api.klipy.com/v2"

const (
	// gifDefaultLimit / gifMaxLimit bound the number of results requested.
	gifDefaultLimit = 20
	gifMaxLimit     = 50

	// gifMaxQueryLen caps the search term length before it is forwarded.
	gifMaxQueryLen = 100

	// gifUpstreamTimeout is the total budget for one upstream call.
	gifUpstreamTimeout = 10 * time.Second

	// gifMaxResponseBytes caps the upstream body we are willing to read so a
	// hostile or oversized response cannot exhaust server memory.
	gifMaxResponseBytes = 2 << 20 // 2 MiB
)

// gifClient performs the upstream call. It reuses the same SSRF-guarded dialer
// as the plugin host_http capability (resolve once, reject private/loopback/
// link-local/CGN addresses, dial only vetted IPs) rather than a bare
// http.Get, and refuses to follow redirects — the upstream host is fixed.
var gifClient = &http.Client{
	Timeout:   gifUpstreamTimeout,
	Transport: &http.Transport{DialContext: plugin.GuardedDialContext()},
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// gifMediaFormat is a single renderable variant of a GIF.
type gifMediaFormat struct {
	URL string `json:"url"`
}

// gifResult is one GIF. Decoding the upstream body into this struct and
// re-encoding it IS the field allowlist: anything Klipy returns that is not
// declared here (including any echo of our API key) is dropped on the floor
// and never reaches the client.
type gifResult struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	MediaFormats struct {
		TinyGif *gifMediaFormat `json:"tinygif,omitempty"`
		Gif     *gifMediaFormat `json:"gif,omitempty"`
	} `json:"media_formats"`
}

// gifResponse is the JSON envelope returned by both GIF endpoints.
type gifResponse struct {
	Results []gifResult `json:"results"`
}

// MountGIFRoutes registers the authenticated GIF proxy endpoints.
//
// Both routes require a session (same as sibling content endpoints) and share
// a dedicated per-IP rate-limit bucket — the picker searches on every debounced
// keystroke, so it must not share the empty-prefix bucket used by password and
// TOTP endpoints.
func MountGIFRoutes(r chi.Router, database *db.DB, limiter *auth.RateLimiter, cfg *config.Config) {
	r.Route("/api/v1/gif", func(r chi.Router) {
		r.Use(AuthMiddleware(database))
		r.Use(rateLimitMiddlewareWithPrefix(limiter, "gif:", gifRateLimitPerMinute, time.Minute, cfg.Server.TrustedProxies))

		r.Get("/search", handleGIFProxy(cfg.GIF.APIKey, "/search", true))
		r.Get("/trending", handleGIFProxy(cfg.GIF.APIKey, "/featured", false))
	})
}

// handleGIFProxy returns a handler that forwards a GIF request upstream with
// the server-held API key. requireQuery marks the endpoints that take a `q`
// search term (search) versus those that do not (trending).
func handleGIFProxy(apiKey, upstreamPath string, requireQuery bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if apiKey == "" {
			writeJSON(w, http.StatusServiceUnavailable, errorResponse{
				Error:   "GIF_DISABLED",
				Message: "GIF search is not configured on this server",
			})
			return
		}

		params := url.Values{
			"key":          {apiKey},
			"media_filter": {"gif,tinygif"},
		}

		limit, ok := parseGIFLimit(r.URL.Query().Get("limit"))
		if !ok {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "limit must be an integer between 1 and " + strconv.Itoa(gifMaxLimit),
			})
			return
		}
		params.Set("limit", strconv.Itoa(limit))

		if requireQuery {
			q := strings.TrimSpace(r.URL.Query().Get("q"))
			if q == "" {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error:   "INVALID_INPUT",
					Message: "q is required",
				})
				return
			}
			if len(q) > gifMaxQueryLen {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error:   "INVALID_INPUT",
					Message: "q must be at most " + strconv.Itoa(gifMaxQueryLen) + " characters",
				})
				return
			}
			params.Set("q", q)
		}

		results, err := fetchGIFs(r, gifAPIBase+upstreamPath+"?"+params.Encode(), apiKey, limit)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, errorResponse{
				Error:   "BAD_GATEWAY",
				Message: "GIF provider is unavailable",
			})
			return
		}

		writeJSON(w, http.StatusOK, gifResponse{Results: results})
	}
}

// fetchGIFs performs the upstream request and returns the allowlisted results.
// It never returns the upstream error to the caller and never logs the request
// URL, because that URL carries the API key.
func fetchGIFs(r *http.Request, upstreamURL, apiKey string, limit int) ([]gifResult, error) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstreamURL, nil)
	if err != nil {
		slog.Warn("gif proxy: building upstream request failed", "error", redactKey(err.Error(), apiKey))
		return nil, err
	}

	resp, err := gifClient.Do(req)
	if err != nil {
		// url.Error embeds the request URL, which contains the API key.
		slog.Warn("gif proxy: upstream request failed", "error", redactKey(err.Error(), apiKey))
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		slog.Warn("gif proxy: upstream returned non-200", "status", resp.StatusCode)
		return nil, errGIFUpstream
	}

	var upstream gifResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, gifMaxResponseBytes)).Decode(&upstream); err != nil {
		slog.Warn("gif proxy: decoding upstream response failed", "error", redactKey(err.Error(), apiKey))
		return nil, err
	}

	// Drop entries missing either renderable format and honour our own limit
	// even if upstream ignored it. Non-nil so the JSON is [] and never null.
	results := make([]gifResult, 0, len(upstream.Results))
	for _, g := range upstream.Results {
		if g.MediaFormats.TinyGif == nil || g.MediaFormats.Gif == nil {
			continue
		}
		if len(results) >= limit {
			break
		}
		results = append(results, g)
	}
	return results, nil
}

// errGIFUpstream marks a non-200 upstream response.
var errGIFUpstream = errors.New("gif proxy: upstream error")

// redactKey removes the API key from a string destined for the logs. It
// matches both the literal key and its percent-encoded query-string form
// (url.Error embeds the encoded request URL, and params.Encode() escapes any
// character outside [A-Za-z0-9-_.~] — common in base64-style keys) so an
// encoded form is caught too.
func redactKey(s, apiKey string) string {
	if apiKey == "" {
		return s
	}
	s = strings.ReplaceAll(s, apiKey, "[REDACTED]")
	return strings.ReplaceAll(s, url.QueryEscape(apiKey), "[REDACTED]")
}

// parseGIFLimit parses and validates the `limit` query param. An empty value
// yields the default; anything non-numeric or out of range is rejected.
func parseGIFLimit(raw string) (int, bool) {
	if raw == "" {
		return gifDefaultLimit, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > gifMaxLimit {
		return 0, false
	}
	return n, true
}
