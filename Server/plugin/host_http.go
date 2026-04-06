// Phase C Step 9 — `http` host capability.
//
// Outbound HTTP requests proxied through the server. Each request is matched
// against PluginsConfig.HTTPAllowlist (host suffix match) before being sent.
// The wazero-tagged build invokes this from the plugin's `host_http_request`
// import; the default build exposes it for testing.
package plugin

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
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

const httpTimeout = 10 * time.Second

// HTTPDo executes a plugin-initiated HTTP request after enforcing the host
// allowlist declared in PluginsConfig.
func (r *Registry) HTTPDo(ctx context.Context, inst *Instance, req HTTPRequest) (*HTTPResponse, error) {
	if !inst.Manifest.HasCapability(CapHTTP) {
		return nil, ErrCapabilityNotGranted
	}
	if !r.hostAllowed(req.URL) {
		return nil, fmt.Errorf("plugin http: host not in allowlist: %s", req.URL)
	}
	httpReq, err := http.NewRequestWithContext(ctx, req.Method, req.URL, strings.NewReader(string(req.Body)))
	if err != nil {
		return nil, fmt.Errorf("plugin http: build request: %w", err)
	}
	for k, v := range req.Header {
		httpReq.Header.Set(k, v)
	}
	client := &http.Client{Timeout: httpTimeout}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("plugin http: do: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("plugin http: read body: %w", err)
	}
	hdr := make(map[string]string, len(resp.Header))
	for k, v := range resp.Header {
		if len(v) > 0 {
			hdr[k] = v[0]
		}
	}
	return &HTTPResponse{
		StatusCode: resp.StatusCode,
		Body:       body,
		Header:     hdr,
	}, nil
}

// hostAllowed reports whether url's host matches any suffix in the allowlist.
func (r *Registry) hostAllowed(url string) bool {
	// Trivial host extraction — full URL parsing would be overkill since the
	// allowlist match is suffix-based.
	rest := url
	for _, prefix := range []string{"https://", "http://"} {
		if strings.HasPrefix(rest, prefix) {
			rest = rest[len(prefix):]
			break
		}
	}
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	for _, suffix := range r.cfg.HTTPAllowlist {
		if strings.HasSuffix(rest, suffix) {
			return true
		}
	}
	return false
}
