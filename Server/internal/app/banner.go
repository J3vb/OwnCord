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

// printBanner writes the startup banner to stderr, apart from the structured
// log. fingerprint is the served leaf certificate's SHA-256 in the client's pin
// format, or "" when there is none (TLS off, or ACME before its first
// handshake).
func printBanner(cfg *config.Config, ver string, tls bool, fingerprint string) {
	scheme := "http"
	if tls {
		scheme = "https"
	}

	addrs := netclass.LocalAddrs()
	localIP, addrKind := pickBannerAddr(addrs)
	port := cfg.Server.Port
	baseURL := scheme + "://" + net.JoinHostPort(localIP, strconv.Itoa(port))
	adminURL := baseURL + "/admin"

	// The most reachable address can be a global IPv6 outside the default admin
	// allowlist (loopback, private, unique-local), so that admin URL answers
	// 403 even from the host; offer a LAN address too.
	lanLine := bannerLANAdminLine(scheme, pickBannerLANAddr(addrs), localIP, port)

	tlsStatus := "disabled"
	if tls {
		tlsStatus = "enabled"
	}

	fpLine := ""
	if fingerprint != "" {
		fpLine = "\n    Certificate  " + fingerprint +
			"\n                 compare this out of band before accepting the\n" +
			"                 client's trust prompt"
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
    Platform %s/%s%s
   ─────────────────────────────────────────────
    API      %s/api/v1/info
    WebSocket   %s/api/v1/ws
    Admin    %s
    Health   %s/health%s
   ─────────────────────────────────────────────
    Address  %s
   ─────────────────────────────────────────────
    Press Ctrl+C to stop the server.

`, cfg.Server.Name, ver, tlsStatus, runtime.GOOS, runtime.GOARCH, fpLine,
		baseURL, wsURL(scheme, localIP, port), adminURL, baseURL, lanLine,
		bannerQualifier(addrKind, localIP, port))

	_, _ = fmt.Fprint(os.Stderr, banner)
}

// printSetupToken writes the setup token to stderr, never slog: the log buffer
// is streamed to the admin panel and may be shipped elsewhere.
func printSetupToken(token string) {
	_, _ = fmt.Fprintf(os.Stderr, `   ─────────────────────────────────────────────
    First-run setup is open. The setup wizard at /admin asks for
    this token; it is valid until setup completes or the server
    restarts.

    Setup token  %s
   ─────────────────────────────────────────────

`, token)
}

func wsURL(httpScheme, ip string, port int) string {
	ws := "ws"
	if httpScheme == "https" {
		ws = "wss"
	}
	return ws + "://" + net.JoinHostPort(ip, strconv.Itoa(port))
}

// diskWarnBytes is the boot-time "getting low" tier; the critical tier is
// server.min_free_disk_mb, which /health and uploads also use.
const diskWarnBytes = 1 << 30 // 1 GiB — warn

// warnLowDisk logs an error below critical (0 disables it) and a warning below
// diskWarnBytes; probe failures are silent.
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

// pickBannerAddr chooses the most widely reachable address in addrs. Ranking by
// netclass.Kind matters because "first global-unicast IPv4" would print a LAN
// address (IsGlobalUnicast is true for RFC1918) or a Docker bridge.
func pickBannerAddr(addrs []netip.Addr) (string, netclass.Kind) {
	best := ""
	bestKind := netclass.KindLoopback
	bestRank := -1
	bestIsV4 := false

	for _, a := range addrs {
		k := netclass.Classify(a)
		rank := netclass.Rank(k)
		isV4 := a.Unmap().Is4()

		// Higher rank wins; at equal rank IPv4 wins, as it is likelier to be
		// usable when copied from a banner.
		if rank > bestRank || (rank == bestRank && isV4 && !bestIsV4) {
			best, bestKind, bestRank, bestIsV4 = a.String(), k, rank, isV4
		}
	}
	if best == "" {
		return "localhost", netclass.KindLoopback
	}
	return best, bestKind
}

// pickBannerLANAddr returns the private or unique-local address the admin
// allowlist is most likely to admit, or "" when none.
func pickBannerLANAddr(addrs []netip.Addr) string {
	var lan []netip.Addr
	for _, a := range addrs {
		if k := netclass.Classify(a); k == netclass.KindPrivate || k == netclass.KindUniqueLocal {
			lan = append(lan, a)
		}
	}
	if len(lan) == 0 {
		return ""
	}
	best, _ := pickBannerAddr(lan)
	return best
}

// bannerLANAdminLine builds the extra "Admin (LAN)" line, or "" when the
// primary admin URL already is the LAN address or there is none.
func bannerLANAdminLine(scheme, lanIP, primaryIP string, port int) string {
	if lanIP == "" || lanIP == primaryIP {
		return ""
	}
	return "\n    Admin (LAN) " + scheme + "://" + net.JoinHostPort(lanIP, strconv.Itoa(port)) + "/admin"
}

// bannerQualifier tells the reader what kind of address was printed.
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
