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
// log on stdout. fingerprint is the served leaf certificate's SHA-256 in the
// client's pin format, or "" when there is none to print (TLS off, or ACME
// before its first handshake); users compare it out of band before accepting
// the client's trust prompt.
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

	// The address above is the most widely reachable one, which on a dual-stack
	// host can be a global IPv6, while the default admin allowlist admits only
	// loopback, private and unique-local addresses, so that admin URL answers
	// 403 even from the host. Offer a LAN address too when one exists.
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

// printSetupToken writes the setup token to stderr beside the banner, never to
// slog: the log buffer is streamed to the admin panel and may be shipped
// elsewhere, and the token must stay on the console of whoever started the
// server.
func printSetupToken(token string) {
	_, _ = fmt.Fprintf(os.Stderr, `   ─────────────────────────────────────────────
    First-run setup is open. The setup wizard at /admin asks for
    this token; it is valid until setup completes or the server
    restarts.

    Setup token  %s
   ─────────────────────────────────────────────

`, token)
}

// wsURL builds the WebSocket URL with the correct scheme.
func wsURL(httpScheme, ip string, port int) string {
	ws := "ws"
	if httpScheme == "https" {
		ws = "wss"
	}
	// JoinHostPort brackets an IPv6 literal, keeping the URL valid.
	return ws + "://" + net.JoinHostPort(ip, strconv.Itoa(port))
}

// diskWarnBytes is the boot-time "getting low" tier, shaping only startup log
// noise. The critical tier is server.min_free_disk_mb, the floor /health
// degrades at and the upload path refuses at, so all three agree.
const diskWarnBytes = 1 << 30 // 1 GiB — warn

// warnLowDisk logs when the volume holding path is low on space: an error
// below critical (the configured floor; 0 disables it), a warning below
// diskWarnBytes. Probe failures are silent: unknown is not full.
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

// pickBannerAddr chooses the most widely reachable address in addrs, taking
// the list as a parameter so tests can inject topologies. Ranking by
// netclass.Kind puts a public address above a private one; "the first
// global-unicast IPv4" would print a LAN address (net.IP's IsGlobalUnicast is
// true for RFC1918) or a Docker bridge.
func pickBannerAddr(addrs []netip.Addr) (string, netclass.Kind) {
	best := ""
	bestKind := netclass.KindLoopback
	bestRank := -1
	bestIsV4 := false

	for _, a := range addrs {
		k := netclass.Classify(a)
		rank := netclass.Rank(k)
		isV4 := a.Unmap().Is4()

		// Higher rank wins; at equal rank IPv4 wins, as an owner copying one
		// address out of a banner is likelier to be able to use it. Further
		// ties keep the first seen.
		if rank > bestRank || (rank == bestRank && isV4 && !bestIsV4) {
			best, bestKind, bestRank, bestIsV4 = a.String(), k, rank, isV4
		}
	}
	if best == "" {
		return "localhost", netclass.KindLoopback
	}
	return best, bestKind
}

// pickBannerLANAddr returns the address the admin allowlist is most likely to
// admit (private or unique-local), or "" when the host has none. It ignores
// reachability ranking because the most reachable address can lie outside the
// default admin perimeter.
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
// primary admin URL already is the LAN address or there is none. Kept apart so
// it is testable without capturing the banner.
func bannerLANAdminLine(scheme, lanIP, primaryIP string, port int) string {
	if lanIP == "" || lanIP == primaryIP {
		return ""
	}
	return "\n    Admin (LAN) " + scheme + "://" + net.JoinHostPort(lanIP, strconv.Itoa(port)) + "/admin"
}

// bannerQualifier is the one line telling the banner's reader what kind of
// address was printed and what that means for anyone outside this machine.
// Every class gets a line, including the one that looks like success: a public
// address on an interface says nothing of the firewall, ISP or forwarding rule,
// and silence is how a reachability limit got read as application success.
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
