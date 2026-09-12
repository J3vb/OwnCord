package app

import (
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"runtime"
	"strconv"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/diskutil"
	"github.com/J3vb/OwnCord/Server/netclass"
)

// printBanner writes the startup banner to stderr (so it doesn't mix with
// the structured log output on stdout).
func printBanner(cfg *config.Config, ver string, tls bool) {
	scheme := "http"
	if tls {
		scheme = "https"
	}

	localIP, addrKind := getOutboundIP()
	port := cfg.Server.Port
	baseURL := scheme + "://" + net.JoinHostPort(localIP, strconv.Itoa(port))
	adminURL := baseURL + "/admin"

	tlsStatus := "disabled"
	if tls {
		tlsStatus = "enabled"
	}

	banner := fmt.Sprintf(`

     ___                  ____              _
    / _ \__      ___ __  / ___|___  _ __ __| |
   | | | \ \ /\ / / '_ \| |   / _ \| '__/ _`+"`"+` |
   | |_| |\ V  V /| | | | |__| (_) | | | (_| |
    \___/  \_/\_/ |_| |_|\____\___/|_|  \__,_|

   ─────────────────────────────────────────────
    Server   %s
    Version  %s
    TLS      %s
    Platform %s/%s
   ─────────────────────────────────────────────
    API      %s/api/v1/info
    WebSocket   %s/api/v1/ws
    Admin    %s
    Health   %s/health
   ─────────────────────────────────────────────
    Address  %s
   ─────────────────────────────────────────────
    Press Ctrl+C to stop the server.

`, cfg.Server.Name, ver, tlsStatus, runtime.GOOS, runtime.GOARCH,
		baseURL, wsURL(scheme, localIP, port), adminURL, baseURL,
		bannerQualifier(addrKind, localIP, port))

	_, _ = fmt.Fprint(os.Stderr, banner)
}

// wsURL builds the WebSocket URL with the correct scheme.
func wsURL(httpScheme, ip string, port int) string {
	ws := "ws"
	if httpScheme == "https" {
		ws = "wss"
	}
	// JoinHostPort brackets an IPv6 literal, so the URL stays valid on an
	// IPv6-only host.
	return ws + "://" + net.JoinHostPort(ip, strconv.Itoa(port))
}

// diskWarnBytes is the boot-time "getting low" tier; it only shapes startup
// log noise. The critical tier is server.min_free_disk_mb — the same floor
// /health degrades at and the upload path refuses at (B5-2, decision 11), so
// the three can never disagree about what "low disk" means.
const diskWarnBytes = 1 << 30 // 1 GiB — warn

// warnLowDisk logs when the volume holding path is low on space: an error
// below critical (the configured floor; 0 disables that tier), a warning
// below diskWarnBytes. Probe failures (unsupported platform, missing dir)
// are silent — unknown ≠ full.
func warnLowDisk(log *slog.Logger, label, path string, critical uint64) {
	free, err := diskutil.FreeBytes(path)
	if err != nil {
		return
	}
	switch {
	case critical > 0 && free < critical:
		log.Error("disk space critically low — writes will start failing soon",
			"volume", label, "path", path, "free_mb", free>>20, "min_free_mb", critical>>20)
	case free < diskWarnBytes:
		log.Warn("disk space low", "volume", label, "path", path, "free_mb", free>>20)
	}
}

// getOutboundIP returns an address this machine can be reached at, for the
// startup banner only, together with how far that address actually reaches.
// It reads the interface table and never opens a socket — the previous UDP
// "dial" of an external address sent no packet, but a network capture still
// saw a connect() to it at every start, which is exactly what BPR-055's proof
// must not contain.
func getOutboundIP() (string, netclass.Kind) {
	return pickBannerAddr(netclass.LocalAddrs())
}

// pickBannerAddr chooses the most widely reachable address in addrs, and is
// the whole of getOutboundIP's decision so it can be tested against injected
// topologies — CI has whatever interfaces the runner has, which is not a
// property worth asserting on.
//
// B6-6: this used to be "the first global-unicast IPv4", and net.IP's
// IsGlobalUnicast is true for RFC1918. On a home server that printed the LAN
// address as the server's address; on a Docker host it could print the bridge.
// Ranking by netclass.Kind fixes both: a public address now outranks a private
// one wherever the interface table happens to list them.
func pickBannerAddr(addrs []netip.Addr) (string, netclass.Kind) {
	best := ""
	bestKind := netclass.KindLoopback
	bestRank := -1
	bestIsV4 := false

	for _, a := range addrs {
		k := netclass.Classify(a)
		rank := netclass.Rank(k)
		isV4 := a.Unmap().Is4()

		// Higher rank wins; at equal rank IPv4 wins, because an owner
		// copying one address out of a banner is far more likely to be able
		// to use it. Ties beyond that keep the first seen.
		if rank > bestRank || (rank == bestRank && isV4 && !bestIsV4) {
			best, bestKind, bestRank, bestIsV4 = a.String(), k, rank, isV4
		}
	}
	if best == "" {
		return "localhost", netclass.KindLoopback
	}
	return best, bestKind
}

// bannerQualifier is the one line B6-6 adds to the banner: what kind of
// address was printed above, and what that means for anyone outside this
// machine trying to use it.
//
// Every class gets a line, including the one that looks like success. A public
// address on an interface does not mean anything can reach it — the firewall,
// the ISP and the forwarding rule are all still unknown from here — and the
// banner saying nothing was how a reachability limit got read as application
// success.
func bannerQualifier(kind netclass.Kind, addr string, port int) string {
	switch kind {
	case netclass.KindGlobal:
		return fmt.Sprintf("This host holds a public address. Clients can reach it only if inbound TCP %d\n"+
			"             is open on your firewall; this server cannot verify that from here.", port)
	case netclass.KindPrivate, netclass.KindUniqueLocal:
		return "LAN only — this host has no public address. Remote access needs port\n" +
			"             forwarding or a tunnel: see docs/port-forwarding.md."
	case netclass.KindCGNAT:
		return fmt.Sprintf("%s is in 100.64.0.0/10: either a carrier-grade NAT address, in which\n"+
			"             case inbound port forwarding cannot work, or Tailscale, in which case it is\n"+
			"             fine. This server cannot tell which — see docs/port-forwarding.md.", addr)
	case netclass.KindLinkLocal:
		return "Link-local address only — reachable from this network segment and nowhere\n" +
			"             else. See docs/port-forwarding.md."
	case netclass.KindLoopback:
		return "No non-loopback address found — only this machine can reach the server."
	default:
		return "This host has no ordinary routable address; the address above is in a\n" +
			"             reserved range. See docs/port-forwarding.md."
	}
}
