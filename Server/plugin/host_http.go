// `http` host capability: requests checked against PluginsConfig.HTTPAllowlist
// and carried by Server/safefetch, which owns the rest of the destination policy.

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

	httpMaxRedirects = 5

	// httpMaxConcurrent bounds fetches in flight across all plugins and registries.
	httpMaxConcurrent = 8
)

// ErrHTTPHostDenied is returned for a host outside the allowlist or resolving to a non-global address.
var ErrHTTPHostDenied = errors.New("plugin http: host denied")

// httpContentTypes is what a plugin may receive. text/plain covers every textual
// format (http.DetectContentType reports it for all); the declared type is
// checked separately, so HTML served as JSON is still refused.
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

// httpFetcher is one per process so the concurrency cap spans all plugins.
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

// HTTPDo executes a plugin HTTP request under the operator host allowlist. The
// allowlist is enforced once, as Request.AllowHost (checked per redirect hop); a
// second check here would leave the suite green with AllowHost removed.
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

// denialError maps allowlist and address-policy refusals to ErrHTTPHostDenied; timeouts and ceilings stay
// distinct.
func denialError(err error) error {
	if errors.Is(err, safefetch.ErrHostNotAllowed) || errors.Is(err, safefetch.ErrBlockedAddress) ||
		errors.Is(err, safefetch.ErrBlockedScheme) || errors.Is(err, safefetch.ErrBlockedPort) ||
		errors.Is(err, safefetch.ErrCredentialsInURL) {
		return fmt.Errorf("%w: %w", ErrHTTPHostDenied, err)
	}
	return fmt.Errorf("plugin http: %w", err)
}

func (r *Registry) allowHostPort(hostport string) bool {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	return r.hostAllowed(host)
}

// hostAllowed reports whether host equals an allowlist entry or is a dot-bounded
// suffix of it ("evilexample.com" does not match "example.com"); empty entries never match.
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
