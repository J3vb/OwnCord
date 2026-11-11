// gif_handler.go is the server-side proxy for the Klipy GIF API. The API key never leaves the server (a
// VITE_ variable is inlined into the shipped bundle). With no gif.api_key both endpoints answer 503
// GIF_DISABLED, which the client uses to hide the picker.

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

// gifAPIBase is the upstream Klipy API root; a var only so tests can point it at a stub.
var gifAPIBase = "https://api.klipy.com/v2"

const (
	gifDefaultLimit = 20
	gifMaxLimit     = 50

	gifMaxQueryLen = 100

	gifMaxPosLen = 256

	gifUpstreamTimeout = 10 * time.Second

	// Caps the upstream body read so a hostile response cannot exhaust server memory.
	gifMaxResponseBytes = 2 << 20 // 2 MiB

	// Bounds concurrent upstream calls: the picker searches on every debounced keystroke, so without a cap
	// typing users are an amplifier.
	gifMaxConcurrentUpstream = 8

	// A trending page is the same for every member for minutes, and each upstream call costs the operator's
	// key a request.
	gifTrendingTTL          = 60 * time.Second
	gifTrendingCacheEntries = 32
)

// gifFetcher performs the upstream call under the outbound-content policy (Server/safefetch): https on 443
// only, no redirects (the host is constant, so a redirect is a provider change or an attack), a 10 s
// deadline, a 2 MiB ceiling and a JSON-only content-type allowlist. text/plain is allowed because
// http.DetectContentType reports it for every textual format; the pairing still refuses an HTML error page.
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

// gifResult is one GIF. Decoding into this struct and re-encoding IS the field allowlist: anything else
// Klipy returns (including any echo of our API key) is dropped.
type gifResult struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	MediaFormats struct {
		TinyGif *gifMediaFormat `json:"tinygif,omitempty"`
		Gif     *gifMediaFormat `json:"gif,omitempty"`
	} `json:"media_formats"`
}

// gifResponse is the JSON envelope of both endpoints; Next is the opaque cursor for the next page, passed
// back as `pos`.
type gifResponse struct {
	Results []gifResult `json:"results"`
	Next    string      `json:"next"`
}

// MountGIFRoutes registers the authenticated GIF proxy endpoints on a dedicated per-IP bucket, since the
// picker's keystroke searches must not share the empty-prefix bucket used by password and TOTP endpoints.
func MountGIFRoutes(r chi.Router, sessions *service.SessionService, limiter *auth.RateLimiter, cfg *config.Config, favorites *service.GIFFavoriteService) {
	r.Route("/api/v1/gif", func(r chi.Router) {
		r.Use(AuthMiddleware(sessions))

		r.Group(func(r chi.Router) {
			r.Use(RateLimitMiddleware(limiter, "gif:", gifRateLimitPerMinute, time.Minute, cfg.Server.TrustedProxies))
			r.Get("/search", handleGIFProxy(cfg.GIF.APIKey, "/search", true))
			r.Get("/trending", handleGIFProxy(cfg.GIF.APIKey, "/featured", false))
		})

		// Saved GIFs are stored URLs with no upstream call, so they get their own, looser bucket.
		r.Group(func(r chi.Router) {
			r.Use(RateLimitMiddleware(limiter, "giffav:", gifFavoritesRateLimitPerMinute, time.Minute, cfg.Server.TrustedProxies))
			r.Get("/favorites", handleListGIFFavorites(favorites))
			r.Put("/favorites", handleAddGIFFavorite(favorites))
			r.Delete("/favorites", handleRemoveGIFFavorite(favorites))
		})
	})
}

// handleGIFProxy forwards a GIF request upstream with the server-held API key; requireQuery marks the
// endpoints that take a `q` search term.
func handleGIFProxy(apiKey, upstreamPath string, requireQuery bool) http.HandlerFunc {
	var trending *gifPageCache
	if !requireQuery {
		trending = newGIFPageCache(gifTrendingTTL, gifTrendingCacheEntries)
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if apiKey == "" {
			writeErr(w, http.StatusServiceUnavailable, httperr.CodeGIFDisabled, "GIF search is not configured on this server")
			return
		}

		params := url.Values{"media_filter": {"gif,tinygif"}}

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

		cacheKey := params.Encode()
		if page, ok := trending.get(cacheKey); ok {
			writeJSON(w, http.StatusOK, page)
			return
		}
		params.Set("key", apiKey)
		page, err := fetchGIFs(r, gifAPIBase+upstreamPath+"?"+params.Encode(), apiKey, limit)
		if err != nil {
			writeErr(w, http.StatusBadGateway, httperr.CodeBadGateway, "GIF provider is unavailable")
			return
		}
		trending.put(cacheKey, page)

		writeJSON(w, http.StatusOK, page)
	}
}

// validGIFResultURL reports whether an upstream media URL is safe for the client to load (https, non-empty
// host, no credentials); safefetch only checked the envelope, and the client fetches these unproxied.
func validGIFResultURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	// Hostname(), not Host: "https://:443/a.gif" has Host ":443" but no hostname.
	return u.Scheme == "https" && u.Hostname() != "" && u.User == nil
}

// gifUpstreamBody is the upstream envelope; `next` is kept raw so an odd type can never fail the page.
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

// validGIFPos reports whether s is an acceptable paging cursor: 1 to gifMaxPosLen characters in
// [A-Za-z0-9._:=+/%~-]. The same rule gates `pos` going upstream and `next` coming back.
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

// fetchGIFs performs the upstream request and returns the allowlisted page. It never returns the upstream
// error or logs the request URL, which carries the API key.
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

	// Drop entries missing either renderable format or carrying a disallowed URL, and honour our own limit.
	// Non-nil so the JSON is [] and never null.
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

	// A cursor that fails the pos rule is dropped; the client sees no further pages.
	next := decodeGIFNext(upstream.Next)
	if next != "" && (!validGIFPos(next) || next == apiKey) {
		slog.Debug("gif proxy: dropped upstream next cursor")
		next = ""
	}
	return gifResponse{Results: results, Next: next}, nil
}

var errGIFUpstream = errors.New("gif proxy: upstream error")

// redactKey removes the API key from log strings, literal and percent-encoded (url.Error embeds the encoded
// request URL).
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

// mountGIF mounts the proxy unconditionally; with no key the endpoints answer 503 GIF_DISABLED rather than
// a 404.
func mountGIF(r chi.Router, cfg *config.Config, svc *service.Services, limiter *auth.RateLimiter) {
	MountGIFRoutes(r, svc.Sessions, limiter, cfg, svc.GIFFavorites)
	if cfg.GIF.APIKey == "" {
		slog.Info("gif.api_key not set — GIF picker disabled (clients will hide it)")
	}
}
