// gif_handler.go is the server-side proxy for the Klipy GIF API. The API key
// lives in server config and never leaves the server: the client asks its own
// server (a VITE_ variable is inlined into the shipped bundle and can never hold
// a credential). With no gif.api_key both endpoints answer 503 GIF_DISABLED,
// which the client uses to hide the picker.

package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/safefetch"
	"github.com/J3vb/OwnCord/Server/service"
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

	// gifMaxPosLen caps the opaque paging cursor (`pos` in, `next` out).
	gifMaxPosLen = 256

	// gifUpstreamTimeout is the total budget for one upstream call.
	gifUpstreamTimeout = 10 * time.Second

	// gifMaxResponseBytes caps the upstream body we are willing to read so a
	// hostile or oversized response cannot exhaust server memory.
	gifMaxResponseBytes = 2 << 20 // 2 MiB

	// gifMaxConcurrentUpstream bounds how many upstream calls this server
	// makes at once. The picker searches on every debounced keystroke, so
	// without a cap a room full of typing users is an amplifier.
	gifMaxConcurrentUpstream = 8
)

// gifFetcher performs the upstream call under the outbound-content policy
// (Server/safefetch): https on 443 only, every resolved address classified
// before connect, no redirects (the host is constant, so a redirect is a
// provider change or an attack), a 10 s deadline, a streaming 2 MiB ceiling on
// the wire and after inflation, a JSON-only content-type allowlist and a
// concurrency cap.
// text/plain is allowed because http.DetectContentType reports it for every
// textual format, JSON included; the pairing still refuses an HTML error page
// served as JSON.
var gifFetcher = safefetch.MustNew(safefetch.Policy{
	Schemes:              []string{"https"},
	Ports:                []int{443},
	ContentTypes:         []string{"application/json", "text/plain"},
	MaxRedirects:         0,
	Deadline:             gifUpstreamTimeout,
	MaxBytes:             gifMaxResponseBytes,
	MaxDecompressedBytes: gifMaxResponseBytes,
	MaxConcurrent:        gifMaxConcurrentUpstream,
})

type gifMediaFormat struct {
	URL string `json:"url"`
}

// gifResult is one GIF. Decoding into this struct and re-encoding IS the field
// allowlist: anything else Klipy returns (including any echo of our API key) is
// dropped.
type gifResult struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	MediaFormats struct {
		TinyGif *gifMediaFormat `json:"tinygif,omitempty"`
		Gif     *gifMediaFormat `json:"gif,omitempty"`
	} `json:"media_formats"`
}

// gifResponse is the JSON envelope of both GIF endpoints. Next is the opaque
// cursor for the following page (Tenor v2's `next`), empty when there is none;
// the client passes it back as `pos`.
type gifResponse struct {
	Results []gifResult `json:"results"`
	Next    string      `json:"next"`
}

// MountGIFRoutes registers the authenticated GIF proxy endpoints. They share a
// dedicated per-IP rate-limit bucket: the picker searches on every debounced
// keystroke and must not share the empty-prefix bucket used by password and TOTP
// endpoints.
func MountGIFRoutes(r chi.Router, sessions *service.SessionService, limiter *auth.RateLimiter, cfg *config.Config, favorites *service.GIFFavoriteService) {
	r.Route("/api/v1/gif", func(r chi.Router) {
		r.Use(AuthMiddleware(sessions))

		r.Group(func(r chi.Router) {
			r.Use(RateLimitMiddleware(limiter, "gif:", gifRateLimitPerMinute, time.Minute, cfg.Server.TrustedProxies))
			r.Get("/search", handleGIFProxy(cfg.GIF.APIKey, "/search", true))
			r.Get("/trending", handleGIFProxy(cfg.GIF.APIKey, "/featured", false))
		})

		// Saved GIFs work without a provider key: they are stored URLs. They
		// make no upstream call, so they get their own, looser bucket.
		r.Group(func(r chi.Router) {
			r.Use(RateLimitMiddleware(limiter, "giffav:", gifFavoritesRateLimitPerMinute, time.Minute, cfg.Server.TrustedProxies))
			r.Get("/favorites", handleListGIFFavorites(favorites))
			r.Put("/favorites", handleAddGIFFavorite(favorites))
			r.Delete("/favorites", handleRemoveGIFFavorite(favorites))
		})
	})
}

// handleGIFProxy returns a handler that forwards a GIF request upstream with
// the server-held API key. requireQuery marks the endpoints that take a `q`
// search term (search) versus those that do not (trending).
func handleGIFProxy(apiKey, upstreamPath string, requireQuery bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if apiKey == "" {
			writeErr(w, http.StatusServiceUnavailable, httperr.CodeGIFDisabled, "GIF search is not configured on this server")
			return
		}

		params := url.Values{
			"key":          {apiKey},
			"media_filter": {"gif,tinygif"},
		}

		limit, ok := parseGIFLimit(r.URL.Query().Get("limit"))
		if !ok {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "limit must be an integer between 1 and "+strconv.Itoa(gifMaxLimit))
			return
		}
		params.Set("limit", strconv.Itoa(limit))

		if requireQuery {
			q := strings.TrimSpace(r.URL.Query().Get("q"))
			if q == "" {
				writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "q is required")
				return
			}
			if len(q) > gifMaxQueryLen {
				writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "q must be at most "+strconv.Itoa(gifMaxQueryLen)+" characters")
				return
			}
			params.Set("q", q)
		}

		if pos := strings.TrimSpace(r.URL.Query().Get("pos")); pos != "" {
			if !validGIFPos(pos) {
				writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "pos must be 1 to "+strconv.Itoa(gifMaxPosLen)+" characters from A-Z a-z 0-9 . _ : = + / % ~ -")
				return
			}
			params.Set("pos", pos)
		}

		page, err := fetchGIFs(r, gifAPIBase+upstreamPath+"?"+params.Encode(), apiKey, limit)
		if err != nil {
			writeErr(w, http.StatusBadGateway, httperr.CodeBadGateway, "GIF provider is unavailable")
			return
		}

		writeJSON(w, http.StatusOK, page)
	}
}

// validGIFResultURL reports whether a URL from inside the upstream body is safe
// for the client to load: parseable, https, non-empty host, no embedded
// credentials. safefetch only checked the envelope; the media URLs are what the
// client fetches next, unproxied.
func validGIFResultURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	// Hostname(), not Host: "https://:443/a.gif" parses with Host == ":443"
	// (non-empty) but Hostname() == "" — a port with no host is not a
	// destination.
	return u.Scheme == "https" && u.Hostname() != "" && u.User == nil
}

// gifUpstreamBody is the upstream envelope as decoded. `next` is kept raw so
// an odd type (number, null, object) can never fail the page of results.
type gifUpstreamBody struct {
	Results []gifResult     `json:"results"`
	Next    json.RawMessage `json:"next"`
}

func decodeGIFNext(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return ""
	}
	switch c := raw[0]; {
	case c == '"':
		var str string
		if err := json.Unmarshal(raw, &str); err != nil {
			return ""
		}
		return str
	case c == '-' || (c >= '0' && c <= '9'):
		var n json.Number
		if err := json.Unmarshal(raw, &n); err != nil {
			return ""
		}
		return n.String()
	default:
		return ""
	}
}

// validGIFPos reports whether s is an acceptable paging cursor: 1 to
// gifMaxPosLen characters in [A-Za-z0-9._:=+/%~-] (what params.Encode escapes).
// The same rule gates the client's `pos` going upstream and upstream's `next`
// coming back, so a hostile upstream cannot hand arbitrary text onward.
func validGIFPos(s string) bool {
	if s == "" || len(s) > gifMaxPosLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '.', c == '_', c == ':', c == '=', c == '-', c == '+', c == '/', c == '%', c == '~':
		default:
			return false
		}
	}
	return true
}

// fetchGIFs performs the upstream request and returns the allowlisted page.
// It never returns the upstream error to the caller and never logs the request
// URL, because that URL carries the API key.
func fetchGIFs(r *http.Request, upstreamURL, apiKey string, limit int) (gifResponse, error) {
	resp, err := gifFetcher.Fetch(r.Context(), safefetch.Request{URL: upstreamURL})
	if err != nil {
		// The error embeds the request URL, which contains the API key.
		slog.Warn("gif proxy: upstream request failed", "error", redactKey(err.Error(), apiKey))
		return gifResponse{}, err
	}
	if resp.StatusCode != http.StatusOK {
		slog.Warn("gif proxy: upstream returned non-200", "status", resp.StatusCode)
		return gifResponse{}, errGIFUpstream
	}

	var upstream gifUpstreamBody
	if err := json.Unmarshal(resp.Body, &upstream); err != nil {
		slog.Warn("gif proxy: decoding upstream response failed", "error", redactKey(err.Error(), apiKey))
		return gifResponse{}, err
	}

	// Drop entries missing either renderable format, or carrying a result URL
	// the client should not be handed, and honour our own limit even if
	// upstream ignored it. Non-nil so the JSON is [] and never null.
	results := make([]gifResult, 0, len(upstream.Results))
	for _, g := range upstream.Results {
		if g.MediaFormats.TinyGif == nil || g.MediaFormats.Gif == nil {
			continue
		}
		if !validGIFResultURL(g.MediaFormats.TinyGif.URL) || !validGIFResultURL(g.MediaFormats.Gif.URL) {
			continue
		}
		if len(results) >= limit {
			break
		}
		results = append(results, g)
	}

	// A cursor that fails the pos rule is dropped, not forwarded: the client
	// simply sees no further pages.
	next := decodeGIFNext(upstream.Next)
	if next != "" && (!validGIFPos(next) || next == apiKey) {
		slog.Debug("gif proxy: dropped upstream next cursor")
		next = ""
	}
	return gifResponse{Results: results, Next: next}, nil
}

var errGIFUpstream = errors.New("gif proxy: upstream error")

// redactKey removes the API key from a string destined for logs, both literal
// and percent-encoded (url.Error embeds the encoded request URL, and
// params.Encode escapes characters outside [A-Za-z0-9-_.~], common in
// base64-style keys).
func redactKey(s, apiKey string) string {
	if apiKey == "" {
		return s
	}
	s = strings.ReplaceAll(s, apiKey, "[REDACTED]")
	return strings.ReplaceAll(s, url.QueryEscape(apiKey), "[REDACTED]")
}

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

// mountGIF mounts the GIF proxy unconditionally; with no key the endpoints
// answer 503 GIF_DISABLED so the client hides the picker instead of discovering
// a 404.
func mountGIF(r chi.Router, cfg *config.Config, svc *service.Services, limiter *auth.RateLimiter) {
	MountGIFRoutes(r, svc.Sessions, limiter, cfg, svc.GIFFavorites)
	if cfg.GIF.APIKey == "" {
		slog.Info("gif.api_key not set — GIF picker disabled (clients will hide it)")
	}
}
