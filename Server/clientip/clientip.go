// Package clientip resolves the real client IP for an HTTP request, honouring
// the operator's trusted_proxies configuration.
//
// SRE-11: this logic lived privately in api/middleware.go, so the WebSocket
// handshake could not use it and logged/audited r.RemoteAddr — the reverse
// proxy's address, not the client's — in the recommended reverse-proxy
// deployment. Extracting it here gives every trust boundary one implementation
// instead of a third parallel copy.
package clientip

import (
	"net"
	"net/http"
	"slices"
	"strings"
)

// ParseCIDRList parses CIDR strings into networks, skipping invalid entries —
// a misconfigured entry must not take the server down. Call it once at
// construction, never on the request path (W3-3a).
func ParseCIDRList(cidrs []string) []*net.IPNet {
	nets := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			continue
		}
		nets = append(nets, n)
	}
	return nets
}

// InNets reports whether ipStr (a plain IP, no port) falls inside any net.
func InNets(ipStr string, nets []*net.IPNet) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// Resolve returns the real client IP for r.
//
// Security model:
//   - Always parse the actual connecting address from r.RemoteAddr.
//   - Only honour X-Real-IP or X-Forwarded-For if the connecting address
//     matches one of the trustedNets. This prevents clients from forging their
//     IP to bypass rate limits or pollute the audit trail.
//   - If trustedNets is empty (the default), RemoteAddr is always used.
//
// X-Forwarded-For wins over X-Real-IP when both are present from a trusted
// proxy: the project's documented nginx and Caddy recipes forward X-Real-IP
// verbatim from whatever the client sent rather than overwriting it, so it is
// only ever a last resort (OC-0240).
func Resolve(r *http.Request, trustedNets []*net.IPNet) string {
	remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		// RemoteAddr without port (e.g. Unix socket or test stub) — use as-is.
		remoteHost = r.RemoteAddr
	}

	if len(trustedNets) == 0 {
		return remoteHost
	}

	if !InNets(remoteHost, trustedNets) {
		return remoteHost
	}

	// Walk X-Forwarded-For from the RIGHT and skip entries that are themselves
	// trusted proxies. The first non-trusted, valid address is the real client.
	// Taking the leftmost entry (BUG-112) would trust a client-supplied value:
	// a client can prepend a spoofed IP (`X-Forwarded-For: <spoofed>, <real>`)
	// that the proxy then appends to, letting it forge per-IP rate-limit and
	// lockout keys. Every header line is joined first: a proxy that adds its
	// own X-Forwarded-For line instead of extending the client's (HAProxy's
	// `option forwardfor`) leaves the client-supplied line first.
	if xff := strings.Join(r.Header.Values("X-Forwarded-For"), ","); xff != "" {
		parts := strings.Split(xff, ",")
		leftmostValid := ""
		for _, part := range slices.Backward(parts) {
			candidate := strings.TrimSpace(part)
			if candidate == "" || net.ParseIP(candidate) == nil {
				continue
			}
			leftmostValid = candidate
			if InNets(candidate, trustedNets) {
				continue // our own proxy hop, keep walking left
			}
			return candidate
		}
		// Every entry fell inside trustedNets — a config that covers client
		// networks too (e.g. trusted_proxies: 10.0.0.0/8 with LAN clients).
		// Falling back to RemoteAddr here would collapse ALL clients behind
		// the proxy into one rate-limit/lockout bucket, so one user's failed
		// logins would lock out everyone. The leftmost valid entry is the
		// furthest-upstream hop — the best distinct per-client key available
		// under such a config. trusted_proxies must list only proxy hops;
		// startup validation warns about entries that cannot be proxies.
		if leftmostValid != "" {
			return leftmostValid
		}
	}

	// Fall back to X-Real-IP only when X-Forwarded-For was absent or wholly
	// unusable. Still validate the extracted IP: this header is untrustworthy
	// on its own, since the documented recipes never overwrite it.
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		if net.ParseIP(xri) != nil {
			return xri
		}
	}

	return remoteHost
}

// RateKey returns the per-IP rate-limit and lockout key for a resolved client
// IP. An IPv6 address is aggregated to its /64, since a single subscriber is
// normally handed a whole /64 and could otherwise rotate through addresses for
// an unlimited budget; IPv4 (including IPv4-mapped IPv6) stays whole. A value
// that does not parse is returned unchanged.
func RateKey(ip string) string {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return ip
	}
	if v4 := parsed.To4(); v4 != nil {
		return v4.String()
	}
	return (&net.IPNet{IP: parsed.Mask(net.CIDRMask(64, 128)), Mask: net.CIDRMask(64, 128)}).String()
}
