package api

import (
	"encoding/binary"
	"log/slog"
	"net/netip"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/updater"
)

// warnOnAdminPeerAddress reports an admin perimeter that will most likely see
// a relay's address instead of the client's. With trusted_proxies empty,
// AdminIPRestrict checks the connecting address; behind a reverse proxy that
// is the proxy (often 127.0.0.1), and in a container it can be the bridge
// gateway (the default route) for connections the engine's port relay carries,
// such as published ports reached over IPv6. The default allowlist admits
// both, so the perimeter then admits every client the relay carries.
//
// tls.mode "off" and a container are the two start-up signals for that
// shape, but the warning fires only when the configured allowlist still
// admits the relay's address: an owner who narrowed admin_allowed_cidrs so
// the loopback/bridge ranges are excluded has already closed the hole, and
// the warning's own suggested fix must silence it. It warns and never
// refuses: a LAN-only install matches it too, and first-run setup is
// additionally gated by the start-up setup token.
func warnOnAdminPeerAddress(cfg *config.Config) {
	if len(cfg.Server.TrustedProxies) > 0 || len(cfg.Server.AdminAllowedCIDRs) == 0 {
		return
	}
	container := updater.RunningInContainer()
	if cfg.TLS.Mode != "off" && !container {
		return
	}
	if !adminAllowlistAdmitsRelay(cfg.Server.AdminAllowedCIDRs, container) {
		return
	}
	slog.Warn("admin_allowed_cidrs is checked against the connecting address and trusted_proxies is empty — "+
		"behind a reverse proxy or a container port relay that address is the relay's (loopback or bridge), "+
		"which the allowlist admits",
		"tls_mode", cfg.TLS.Mode,
		"container", container,
		"fix", "set server.trusted_proxies to the proxy hop(s), or narrow server.admin_allowed_cidrs to "+
			"addresses only the owner uses. Ignore this if clients reach the server directly on a LAN")
}

// adminAllowlistAdmitsRelay reports whether any admin_allowed_cidrs entry
// admits a relay's likely connecting address: loopback (a same-host reverse
// proxy), or — inside a container — the bridge gateway the engine relays
// published ports through. That gateway is the container's default route,
// whatever pool the engine (Docker, Podman) allocated the network from; when
// the route table cannot be read it falls back to Docker's default
// 172.16.0.0/12 pool. An entry is tested for overlap, so both a broad prefix
// (0.0.0.0/0) and the relay's exact /32 count; invalid entries are skipped
// here because config.Load already warned about them.
func adminAllowlistAdmitsRelay(cidrs []string, container bool) bool {
	ranges := []netip.Prefix{
		netip.MustParsePrefix("127.0.0.0/8"),
		netip.MustParsePrefix("::1/128"),
	}
	if container {
		bridge := netip.MustParsePrefix("172.16.0.0/12")
		if gw, ok := defaultGateway(); ok {
			bridge = netip.PrefixFrom(gw, 32)
		}
		ranges = append(ranges, bridge)
	}
	for _, c := range cidrs {
		p, err := netip.ParsePrefix(c)
		if err != nil {
			continue
		}
		if slices.ContainsFunc(ranges, p.Overlaps) {
			return true
		}
	}
	return false
}

// routeTablePath is the kernel's IPv4 route table; a variable so tests can
// point it at a fixture.
var routeTablePath = "/proc/net/route"

// defaultGateway returns the IPv4 gateway of the default route in
// routeTablePath, whose addresses are hex in host byte order.
func defaultGateway() (netip.Addr, bool) {
	data, err := os.ReadFile(routeTablePath)
	if err != nil {
		return netip.Addr{}, false
	}
	for line := range strings.SplitSeq(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 3 || f[1] != "00000000" {
			continue
		}
		gw, err := strconv.ParseUint(f[2], 16, 32)
		if err != nil || gw == 0 {
			continue
		}
		var b [4]byte
		binary.NativeEndian.PutUint32(b[:], uint32(gw))
		return netip.AddrFrom4(b), true
	}
	return netip.Addr{}, false
}
