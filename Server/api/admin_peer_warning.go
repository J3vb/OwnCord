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

// warnOnAdminPeerAddress reports an admin perimeter that will most likely see a relay's address instead of
// the client's. With trusted_proxies empty, AdminIPRestrict checks the connecting address: behind a reverse
// proxy that is the proxy, and in a container it can be the bridge gateway, so the default allowlist admits
// every client the relay carries. It fires only when the allowlist still admits the relay's address (the
// suggested fix must silence it). It warns and never refuses: a LAN-only install matches too, and first-run
// setup is gated by the start-up setup token.
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
		"effect", "every client the relay carries passes the /admin check and shares one rate-limit bucket",
		"fix", "set server.trusted_proxies to the proxy hop(s), or narrow server.admin_allowed_cidrs to "+
			"addresses only the owner uses. Ignore this if clients reach the server directly on a LAN")
}

// adminAllowlistAdmitsRelay reports whether any admin_allowed_cidrs entry admits a relay's likely address:
// loopback, or in a container the default-route gateway (falling back to Docker's 172.16.0.0/12 when the
// route table is unreadable). Entries are tested for overlap; invalid ones are skipped (config.Load warned).
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

// routeTablePath is the kernel's IPv4 route table; a var so tests can point it at a fixture.
var routeTablePath = "/proc/net/route"

// defaultGateway returns the IPv4 default-route gateway from routeTablePath (hex, host byte order).
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
