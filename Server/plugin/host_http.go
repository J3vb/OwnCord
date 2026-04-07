// Phase C Step 9 — `http` host capability.
//
// Outbound HTTP requests proxied through the server. Each request is matched
// against PluginsConfig.HTTPAllowlist (host suffix match) before being sent.
// The wazero-tagged build invokes this from the plugin's `host_http_request`
// import; the default build exposes it for testing.
package plugin

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
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

const (
	httpTimeout      = 10 * time.Second
	maxResponseBytes = 5 * 1024 * 1024 // 5 MiB
)

// ErrHTTPHostDenied is returned when a plugin HTTP request targets a host that
// is not in the allowlist or resolves to a private/loopback/link-local address.
var ErrHTTPHostDenied = errors.New("plugin http: host denied")

// HTTPDo executes a plugin-initiated HTTP request after enforcing the host
// allowlist declared in PluginsConfig and rejecting requests that resolve to
// private, loopback, or link-local IP ranges (SSRF defense).
func (r *Registry) HTTPDo(ctx context.Context, inst *Instance, req HTTPRequest) (*HTTPResponse, error) {
	if !inst.Manifest.HasCapability(CapHTTP) {
		return nil, ErrCapabilityNotGranted
	}
	parsed, err := url.Parse(req.URL)
	if err != nil {
		return nil, fmt.Errorf("plugin http: invalid URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("plugin http: scheme %q not allowed", parsed.Scheme)
	}
	host := parsed.Hostname()
	if host == "" {
		return nil, fmt.Errorf("plugin http: empty host")
	}
	if !r.hostAllowed(host) {
		return nil, fmt.Errorf("%w: %s", ErrHTTPHostDenied, host)
	}
	if err := rejectPrivateAddrs(ctx, host); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrHTTPHostDenied, err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, req.Method, req.URL, bytes.NewReader(req.Body))
	if err != nil {
		return nil, fmt.Errorf("plugin http: build request: %w", err)
	}
	for k, v := range req.Header {
		httpReq.Header.Set(k, v)
	}
	// Custom transport with a guarded DialContext: every actual TCP dial
	// re-checks the resolved IP, closing the DNS-rebinding TOCTOU window
	// between rejectPrivateAddrs above and the underlying dial.
	dialer := &net.Dialer{Timeout: httpTimeout}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			h, _, splitErr := net.SplitHostPort(addr)
			if splitErr != nil {
				return nil, splitErr
			}
			ip := net.ParseIP(h)
			if ip == nil {
				// Hostname — resolve and validate every address before dial.
				if err := rejectPrivateAddrs(ctx, h); err != nil {
					return nil, fmt.Errorf("%w: %v", ErrHTTPHostDenied, err)
				}
			} else if err := ipAllowed(ip); err != nil {
				return nil, fmt.Errorf("%w: %v", ErrHTTPHostDenied, err)
			}
			return dialer.DialContext(ctx, network, addr)
		},
	}
	client := &http.Client{
		Timeout:   httpTimeout,
		Transport: transport,
		// Refuse to follow redirects across hosts that the allowlist would
		// reject — re-evaluate the new URL through the same checks.
		CheckRedirect: func(redirReq *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			h := redirReq.URL.Hostname()
			if !r.hostAllowed(h) {
				return fmt.Errorf("%w: redirect to %s", ErrHTTPHostDenied, h)
			}
			if err := rejectPrivateAddrs(redirReq.Context(), h); err != nil {
				return fmt.Errorf("%w: redirect to private addr: %v", ErrHTTPHostDenied, err)
			}
			return nil
		},
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("plugin http: do: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	// Cap body size so a hostile/large response cannot OOM the host. We
	// LimitReader to maxResponseBytes+1 so we can detect truncation.
	limited := io.LimitReader(resp.Body, maxResponseBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("plugin http: read body: %w", err)
	}
	if int64(len(body)) > maxResponseBytes {
		return nil, fmt.Errorf("plugin http: response exceeds %d bytes", maxResponseBytes)
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

// rejectPrivateAddrs resolves host and returns an error if any resolved
// address is loopback, link-local, private (RFC1918), or unspecified.
// This prevents an allowlisted hostname from being repointed at internal
// services via DNS.
func rejectPrivateAddrs(ctx context.Context, host string) error {
	// If host is already an IP literal, check it directly.
	if ip := net.ParseIP(host); ip != nil {
		return ipAllowed(ip)
	}
	resolver := &net.Resolver{}
	ips, err := resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return fmt.Errorf("dns lookup failed: %w", err)
	}
	if len(ips) == 0 {
		return fmt.Errorf("no addresses for %s", host)
	}
	for _, addr := range ips {
		if err := ipAllowed(addr.IP); err != nil {
			return err
		}
	}
	return nil
}

// cgnRange covers RFC6598 carrier-grade NAT (100.64.0.0/10). net.IP.IsPrivate
// does NOT include this range, but it is non-routable on the public internet
// and may reach internal services on carrier networks.
var cgnRange = &net.IPNet{IP: net.IPv4(100, 64, 0, 0).To4(), Mask: net.CIDRMask(10, 32)}

// ipAllowed reports nil if ip is a public, routable address. Loopback,
// link-local, multicast, unspecified, RFC1918, RFC4193, and RFC6598 (CGN)
// ranges are rejected.
func ipAllowed(ip net.IP) error {
	if ip == nil {
		return fmt.Errorf("nil ip")
	}
	if ip.IsLoopback() {
		return fmt.Errorf("loopback address %s", ip)
	}
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return fmt.Errorf("link-local address %s", ip)
	}
	if ip.IsPrivate() {
		return fmt.Errorf("private address %s", ip)
	}
	if ip.IsUnspecified() {
		return fmt.Errorf("unspecified address %s", ip)
	}
	if ip.IsMulticast() {
		return fmt.Errorf("multicast address %s", ip)
	}
	if v4 := ip.To4(); v4 != nil && cgnRange.Contains(v4) {
		return fmt.Errorf("carrier-grade NAT address %s", ip)
	}
	return nil
}
