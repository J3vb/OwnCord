// Package clientip resolves the real client IP per the operator's
// trusted_proxies. Every trust boundary shares it, so none logs or audits
// r.RemoteAddr, which is the reverse proxy's address in the recommended deployment.
package clientip

import (
	"net"
	"net/http"
	"slices"
	"strings"
)

// ParseCIDRList parses CIDR strings, skipping invalid entries so a misconfigured
// one cannot take the server down. Call it at construction, not per request.
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

// CoversEveryAddress reports whether n spans the whole IPv4 or IPv6 space,
// including IPv4-mapped forms like ::ffff:0.0.0.0/96 that match every IPv4 client.
func CoversEveryAddress(n *net.IPNet) bool {
	return (n.Contains(net.IPv4zero) && n.Contains(net.IPv4bcast)) ||
		(n.Contains(net.IPv6zero) && n.Contains(allOnesIPv6))
}

var allOnesIPv6 = net.IP{
	0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
	0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
}

// FirstCatchAll returns the first parseable cidrs entry covering every address,
// so a trusted-proxy list can be refused before any client chooses its own address.
func FirstCatchAll(cidrs []string) (entry string, found bool) {
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err == nil && CoversEveryAddress(n) {
			return c, true
		}
	}
	return "", false
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

// Resolve returns the real client IP for r. X-Real-IP and X-Forwarded-For are
// honoured only when r.RemoteAddr matches trustedNets, so clients cannot forge
// their IP to bypass rate limits or pollute the audit trail; with no trustedNets
// RemoteAddr is always used. X-Forwarded-For wins over X-Real-IP because the
// documented nginx and Caddy recipes forward X-Real-IP verbatim from the client.
func Resolve(r *http.Request, trustedNets []*net.IPNet) string {
	remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		remoteHost = r.RemoteAddr
	}

	if len(trustedNets) == 0 {
		return remoteHost
	}

	if !InNets(remoteHost, trustedNets) {
		return remoteHost
	}

	// Walk X-Forwarded-For from the RIGHT, skipping trusted proxies; the first
	// non-trusted valid address is the client. The leftmost entry is client-supplied
	// (`X-Forwarded-For: <spoofed>, <real>`) and would forge rate-limit and lockout
	// keys. All header lines are joined first: a proxy that adds its own line
	// (HAProxy's `option forwardfor`) leaves the client's line first.
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
		// Every entry is a trusted proxy (trusted_proxies covers client networks too).
		// RemoteAddr would collapse ALL clients into one rate-limit/lockout bucket so
		// one user's failed logins lock out everyone; use the leftmost valid entry, the
		// furthest-upstream hop, as the best distinct key. trusted_proxies must list
		// only proxy hops; startup validation warns about entries that cannot be proxies.
		if leftmostValid != "" {
			return leftmostValid
		}
	}

	// X-Real-IP is a last resort, used only when X-Forwarded-For is absent or
	// unusable, and still validated: the documented recipes never overwrite it.
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		if net.ParseIP(xri) != nil {
			return xri
		}
	}

	return remoteHost
}

// RateKey returns the per-IP rate-limit and lockout key. IPv6 aggregates to its
// /64, since one subscriber is normally handed a whole /64 and could otherwise
// rotate addresses for an unlimited budget; IPv4 stays whole; unparseable input is unchanged.
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
