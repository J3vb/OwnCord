package app

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"runtime"
	"strconv"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/diskutil"
)

// printBanner writes the startup banner to stderr (so it doesn't mix with
// the structured log output on stdout).
func printBanner(cfg *config.Config, ver string, tls bool) {
	scheme := "http"
	if tls {
		scheme = "https"
	}

	localIP := getOutboundIP()
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
    Press Ctrl+C to stop the server.

`, cfg.Server.Name, ver, tlsStatus, runtime.GOOS, runtime.GOARCH,
		baseURL, wsURL(scheme, localIP, port), adminURL, baseURL)

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

// Free-space thresholds for the boot-time disk warning. /health uses its own
// (lower) continuous threshold; these only shape startup log noise.
const (
	diskWarnBytes     = 1 << 30   // 1 GiB — warn
	diskCriticalBytes = 256 << 20 // 256 MiB — error
)

// warnLowDisk logs when the volume holding path is low on space. Probe
// failures (unsupported platform, missing dir) are silent — unknown ≠ full.
func warnLowDisk(log *slog.Logger, label, path string) {
	free, err := diskutil.FreeBytes(path)
	if err != nil {
		return
	}
	switch {
	case free < diskCriticalBytes:
		log.Error("disk space critically low — writes will start failing soon",
			"volume", label, "path", path, "free_mb", free>>20)
	case free < diskWarnBytes:
		log.Warn("disk space low", "volume", label, "path", path, "free_mb", free>>20)
	}
}

// getOutboundIP returns an address this machine can be reached at, for the
// startup banner only: the first global-unicast IPv4 on any interface, else
// the first global-unicast IPv6, else "localhost". It reads the interface
// table and never opens a socket — the previous UDP "dial" of an external
// address sent no packet, but a network capture still saw a connect() to it
// at every start, which is exactly what BPR-055's proof must not contain.
func getOutboundIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "localhost"
	}
	v6 := ""
	for _, a := range addrs {
		ipNet, ok := a.(*net.IPNet)
		if !ok || !ipNet.IP.IsGlobalUnicast() {
			continue
		}
		if ip4 := ipNet.IP.To4(); ip4 != nil {
			return ip4.String()
		}
		if v6 == "" {
			v6 = ipNet.IP.String()
		}
	}
	if v6 != "" {
		return v6
	}
	return "localhost"
}
