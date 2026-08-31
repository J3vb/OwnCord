package app

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"runtime"

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
	baseURL := fmt.Sprintf("%s://%s:%d", scheme, localIP, port)
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
	return fmt.Sprintf("%s://%s:%d", ws, ip, port)
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

// getOutboundIP returns the preferred outbound IP of this machine by dialing
// a known external address (no actual connection is made with UDP).
func getOutboundIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "localhost"
	}
	defer conn.Close() //nolint:errcheck
	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		slog.Warn("getOutboundIP: unexpected LocalAddr type, falling back to localhost",
			"type", fmt.Sprintf("%T", conn.LocalAddr()))
		return "localhost"
	}
	return addr.IP.String()
}
