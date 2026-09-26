package api

import (
	"net/http"
	"net/netip"
	"net/url"
	"runtime"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/netclass"
	"github.com/J3vb/OwnCord/Server/ws"
)

// diagnosticsResponse is returned by GET /api/v1/diagnostics/connectivity.
type diagnosticsResponse struct {
	Server serverDiag `json:"server"`
	Voice  voiceDiag  `json:"voice"`
	Client clientDiag `json:"client"`

	// Reachability is nil unless server.reachability_report_enabled is set
	// (B6-6). A pointer with omitempty rather than a value, so the key is
	// absent when the owner has not opted in — an empty object would read as
	// "nothing to report" rather than "not switched on".
	Reachability *netclass.Report `json:"reachability,omitempty"`
}

type serverDiag struct {
	Version     string `json:"version"`
	Uptime      int64  `json:"uptime_s"`
	GoVersion   string `json:"go_version"`
	OnlineUsers int    `json:"online_users"`
}

type voiceDiag struct {
	Enabled       bool   `json:"enabled"`
	LiveKitURL    string `json:"livekit_url,omitempty"`
	LiveKitHealth bool   `json:"livekit_health"`
	NodeIP        string `json:"node_ip,omitempty"`
	ProxyPath     string `json:"proxy_path"`
}

type clientDiag struct {
	RemoteAddr   string `json:"remote_addr"`
	IsPrivateNet bool   `json:"is_private_network"`
	// AddressClass names the range RemoteAddr falls in. IsPrivateNet alone
	// cannot distinguish a tailnet peer from a LAN host from a carrier-NAT
	// client, and B6-6 is precisely about not conflating those.
	AddressClass netclass.Kind `json:"address_class"`
}

func handleDiagnosticsConnectivity(
	cfg *config.Config,
	ver string,
	hub *ws.Hub,
) http.HandlerFunc {
	proxyNets := parseCIDRList(cfg.Server.TrustedProxies) // OC-0305: parse once at construction
	return func(w http.ResponseWriter, r *http.Request) {
		clientAddr := clientIPWithProxies(r, proxyNets)

		lkHealthy := false
		if ok, _ := hub.LiveKitHealthCheck(r.Context()); ok {
			lkHealthy = true
		}

		// Strip credentials from LiveKit URL before exposing in diagnostics.
		sanitizedLKURL := ""
		if cfg.Voice.LiveKitURL != "" {
			if parsed, parseErr := url.Parse(cfg.Voice.LiveKitURL); parseErr == nil {
				sanitizedLKURL = parsed.Host
			}
		}

		resp := diagnosticsResponse{
			Server: serverDiag{
				Version:     ver,
				Uptime:      int64(time.Since(serverStartTime).Seconds()),
				GoVersion:   runtime.Version(),
				OnlineUsers: hub.ClientCount(),
			},
			Voice: voiceDiag{
				Enabled:       cfg.Voice.LiveKitURL != "",
				LiveKitURL:    sanitizedLKURL,
				LiveKitHealth: lkHealthy,
				NodeIP:        cfg.Voice.NodeIP,
				ProxyPath:     "/livekit",
			},
			Client: clientDiag{
				RemoteAddr:   clientAddr,
				IsPrivateNet: isPrivateIP(clientAddr),
				AddressClass: classifyIP(clientAddr),
			},
		}

		// B6-6: owner opt-in. Building the report opens no socket and
		// resolves no name — see the netclass package comment for why there
		// is no probe — so it adds no latency budget to this handler beyond
		// the LiveKit health check above, which carries its own 3s timeout.
		if cfg.Server.ReachabilityReportEnabled {
			report := netclass.BuildReport(netclass.LocalAddrs(), netclass.Params{
				ListenPort:   cfg.Server.Port,
				TLSMode:      cfg.TLS.Mode,
				VoiceEnabled: cfg.Voice.LiveKitURL != "",
				VoiceNodeIP:  cfg.Voice.NodeIP,
			})
			resp.Reachability = &report
		}

		writeJSON(w, http.StatusOK, resp)
	}
}

// classifyIP names the range ip falls in, or KindOther when it does not parse.
func classifyIP(ip string) netclass.Kind {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return netclass.KindOther
	}
	return netclass.Classify(addr)
}

// isPrivateIP reports whether ip reaches this server from somewhere other than
// the public internet.
//
// It used to be a list of string prefixes, which could not see three ranges
// that matter here: 100.64.0.0/10 (carrier-grade NAT, and the range Tailscale
// hands out — docs/tailscale.md:19-24), 169.254.0.0/16 and fe80::/10
// (link-local), and any IPv4-mapped form such as ::ffff:192.168.1.1. A
// tailnet peer was reported as a public-internet client, which is exactly the
// confusion B6-6 exists to remove.
//
// The documentation and benchmarking ranges stay false, as they always were:
// they are not private, they are simply not allocated to anyone.
func isPrivateIP(ip string) bool {
	switch classifyIP(ip) {
	case netclass.KindLoopback, netclass.KindPrivate, netclass.KindUniqueLocal,
		netclass.KindCGNAT, netclass.KindLinkLocal:
		return true
	default:
		return false
	}
}
