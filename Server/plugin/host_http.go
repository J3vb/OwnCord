// Phase C Step 9 — `http` host capability.
//
// Outbound HTTP requests proxied through the server. Each request is matched
// against PluginsConfig.HTTPAllowlist (host suffix match) and then carried by
// Server/safefetch, which owns the destination and resource policy — address
// classification, the connect-to-validated-address binding, redirects, the
// deadline, the byte ceilings and the content-type allowlist. The
// wazero-tagged build invokes this from the plugin's `host_http_request`
// import; the default build exposes it for testing.

package plugin

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/safefetch"
)

// HTTPRequest is the plugin → host request envelope.
type HTTPRequest struct {
	Method string
	URL    string
	Body   []byte
	Header map[string]string
}

// HTTPResponse is the host → plugin response envelope.
type HTTPResponse struct {
	StatusCode int
	Body       []byte
	Header     map[string]string
}

const (
	httpTimeout      = 10 * time.Second
	maxResponseBytes = 5 * 1024 * 1024 // 5 MiB

	// httpMaxRedirects is the hop budget. It matches what this capability
	// followed before safefetch, except that every hop is now put through the
	// whole destination check rather than only the host allowlist.
	httpMaxRedirects = 5

	// httpMaxConcurrent bounds plugin fetches in flight across every plugin
	// and every registry. A plugin loop that fetches without waiting is
	// otherwise a way to spend all of the server's sockets.
	httpMaxConcurrent = 8
)

// ErrHTTPHostDenied is returned when a plugin HTTP request targets a host that
// is not in the allowlist or resolves to a non-globally-routable address.
var ErrHTTPHostDenied = errors.New("plugin http: host denied")

// httpContentTypes is what a plugin may receive. It is deliberately wider
// than the GIF proxy's list — a plugin fetches whatever its own upstream
// serves — but it is still a list: an operator who allowlists a host has not
// agreed to that host handing plugin code an arbitrary binary format.
//
// text/plain covers every textual format, because http.DetectContentType
// reports it for all of them; the declared type is checked separately, so an
// HTML page served as JSON is still refused.
var httpContentTypes = []string{
	"application/json",
	"application/xml",
	"application/xhtml+xml",
	"application/javascript",
	"application/x-www-form-urlencoded",
	"application/octet-stream",
	"text/plain",
	"text/html",
	"text/xml",
	"text/csv",
	"text/css",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
}

// httpFetcher carries every plugin request. One per process, so the
// concurrency cap counts every plugin's fetches together; the per-request
// AllowHost hook carries each registry's own operator allowlist.
var httpFetcher = safefetch.MustNew(safefetch.Policy{
	Schemes:              []string{"http", "https"},
	Ports:                []int{80, 443},
	ContentTypes:         httpContentTypes,
	MaxRedirects:         httpMaxRedirects,
	Deadline:             httpTimeout,
	MaxBytes:             maxResponseBytes,
	MaxDecompressedBytes: maxResponseBytes,
	MaxConcurrent:        httpMaxConcurrent,
})

// HTTPDo executes a plugin-initiated HTTP request under the operator host
// allowlist declared in PluginsConfig. Everything else — parsing, address
// classification, the dial binding, redirects, the deadline, the byte
// ceilings and the content-type allowlist — is Server/safefetch's.
//
// The allowlist is enforced once, as Request.AllowHost, which safefetch
// consults for the plugin's own URL and for every redirect hop alike. An
// earlier version also checked it here first; that second check was
// redundant, and it made the wiring untestable — removing AllowHost left the
// suite green, because this check refused the same requests on its own.
func (r *Registry) HTTPDo(ctx context.Context, inst *Instance, req HTTPRequest) (*HTTPResponse, error) {
	if !inst.Manifest.HasCapability(CapHTTP) {
		return nil, ErrCapabilityNotGranted
	}
	resp, err := httpFetcher.Fetch(ctx, safefetch.Request{
		Method:    req.Method,
		URL:       req.URL,
		Body:      req.Body,
		Header:    req.Header,
		AllowHost: r.allowHostPort,
	})
	if err != nil {
		return nil, denialError(err)
	}
	hdr := make(map[string]string, len(resp.Header))
	for k, v := range resp.Header {
		if len(v) > 0 {
			hdr[k] = v[0]
		}
	}
	return &HTTPResponse{StatusCode: resp.StatusCode, Body: resp.Body, Header: hdr}, nil
}

// denialError keeps ErrHTTPHostDenied the single sentinel a caller tests for
// when a destination is refused, whether the allowlist or the address policy
// refused it. Everything else — a timeout, a ceiling, an unreachable host —
// stays distinguishable.
func denialError(err error) error {
	if errors.Is(err, safefetch.ErrHostNotAllowed) || errors.Is(err, safefetch.ErrBlockedAddress) ||
		errors.Is(err, safefetch.ErrBlockedScheme) || errors.Is(err, safefetch.ErrBlockedPort) ||
		errors.Is(err, safefetch.ErrCredentialsInURL) {
		return fmt.Errorf("%w: %w", ErrHTTPHostDenied, err)
	}
	return fmt.Errorf("plugin http: %w", err)
}

// allowHostPort is the per-hop allowlist check safefetch calls. It takes a
// "host:port" because that is what an origin is; the allowlist is written in
// hostnames, so the port is dropped before matching.
func (r *Registry) allowHostPort(hostport string) bool {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	return r.hostAllowed(host)
}

// hostAllowed reports whether host matches any allowlist entry. Matching is
// either exact (host == entry) or proper suffix bounded by a dot
// (host == "api."+entry or host ends with "."+entry). This rejects
// "evilexample.com" against an allowlist of "example.com".
//
// Empty allowlist entries are ignored to prevent the empty-suffix wildcard
// bug. host is expected to already be a clean hostname (no scheme/port/path).
func (r *Registry) hostAllowed(host string) bool {
	if host == "" {
		return false
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, entry := range r.cfg.HTTPAllowlist {
		entry = strings.ToLower(strings.TrimSpace(entry))
		if entry == "" {
			continue
		}
		if host == entry {
			return true
		}
		if strings.HasSuffix(host, "."+entry) {
			return true
		}
	}
	return false
}
