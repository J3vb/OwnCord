package admin

import (
	"log/slog"
	"net"

	"github.com/J3vb/OwnCord/Server/clientip"
)

// The first-run setup endpoint resolves its client IP (the rate-limit bucket
// key and the session IP recorded for the new Owner account) through the
// shared clientip.Resolve, the same proxy-aware resolver api's middleware and
// the WebSocket handshake use (OC-0274).

// setupParseCIDRList parses CIDR strings into networks, skipping invalid
// entries with a warning — a misconfigured entry must not take the server
// down. Called once per handler at construction (see handleSetup), never on
// the request path.
func setupParseCIDRList(cidrs []string) []*net.IPNet {
	for _, c := range cidrs {
		if _, _, err := net.ParseCIDR(c); err != nil {
			slog.Warn("ignoring invalid CIDR entry (use address/prefix notation, e.g. 10.0.0.1/32)",
				"cidr", c, "error", err)
		}
	}
	return clientip.ParseCIDRList(cidrs)
}
