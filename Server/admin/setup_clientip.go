package admin

import (
	"log/slog"
	"net"
	"net/http"
	"strings"
)

// This file gives the first-run setup endpoint the same proxy-aware client
// IP resolution every other session-creating path uses
// (api.clientIPWithProxies, used by register/login/AdminIPRestrict/rate
// limiting). admin cannot import api — api imports admin, and that would be
// a cycle — so the algorithm is reproduced here rather than shared. Keep it
// in lockstep with api/middleware.go's clientIPWithProxies/parseCIDRList/
// ipInNets if that logic ever changes (OC-0274).

// setupParseCIDRList parses CIDR strings into networks, skipping invalid
// entries with a warning — a misconfigured entry must not take the server
// down. Called once per handler at construction (see handleSetup), never on
// the request path.
func setupParseCIDRList(cidrs []string) []*net.IPNet {
	nets := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			slog.Warn("ignoring invalid CIDR entry (use address/prefix notation, e.g. 10.0.0.1/32)",
				"cidr", c, "error", err)
			continue
		}
		nets = append(nets, n)
	}
	return nets
}

// setupIPInNets reports whether ipStr (a plain IP, no port) falls inside any
// of the parsed networks.
func setupIPInNets(ipStr string, nets []*net.IPNet) bool {
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

// setupClientIP returns the real client IP for the first-run setup endpoint,
// used both as the rate-limit bucket key and as the session IP recorded for
// the new Owner account.
//
// Security model (identical to api.clientIPWithProxies):
//   - Always parse the actual connecting address from r.RemoteAddr.
//   - Only honour X-Forwarded-For/X-Real-IP when the connecting address
//     matches one of trustedNets. Otherwise a client could forge its IP to
//     bypass the setup rate limit.
//   - If trustedNets is empty (no trusted_proxies configured, or no running
//     config at all — the legacy/test construction path), RemoteAddr is
//     always used.
func setupClientIP(r *http.Request, trustedNets []*net.IPNet) string {
	remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		// RemoteAddr without a port (e.g. Unix socket or test stub) — use as-is.
		remoteHost = r.RemoteAddr
	}

	if len(trustedNets) == 0 {
		return remoteHost
	}

	if !setupIPInNets(remoteHost, trustedNets) {
		return remoteHost
	}

	// Prefer X-Forwarded-For when coming from a trusted proxy. Walk from the
	// RIGHT and skip entries that are themselves trusted proxies — the first
	// non-trusted, valid address is the real client. Taking the leftmost
	// entry would trust a client-supplied value (a client can prepend a
	// spoofed IP that the proxy then appends to).
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		leftmostValid := ""
		for i := len(parts) - 1; i >= 0; i-- {
			candidate := strings.TrimSpace(parts[i])
			if candidate == "" || net.ParseIP(candidate) == nil {
				continue
			}
			leftmostValid = candidate
			if setupIPInNets(candidate, trustedNets) {
				continue // our own proxy hop, keep walking left
			}
			return candidate
		}
		// Every entry fell inside trustedNets — a config that covers client
		// networks too. Falling back to RemoteAddr here would collapse every
		// client behind the proxy into one rate-limit/session-IP bucket, so
		// use the furthest-upstream hop instead — the best distinct per-client
		// value available under such a config.
		if leftmostValid != "" {
			return leftmostValid
		}
	}

	// Fall back to X-Real-IP only when X-Forwarded-For was absent or wholly
	// unusable. Still validate it — this header is untrustworthy on its own.
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		if net.ParseIP(xri) != nil {
			return xri
		}
	}

	return remoteHost
}
