package api

import (
	"net/http"
	"net/url"
	"runtime"
	"time"

	"github.com/owncord/server/config"
	"github.com/owncord/server/ws"
)

// diagnosticsResponse is returned by GET /api/v1/diagnostics/connectivity.
type diagnosticsResponse struct {
	Server serverDiag `json:"server"`
	Voice  voiceDiag  `json:"voice"`
	Client clientDiag `json:"client"`
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
}

func handleDiagnosticsConnectivity(
	cfg *config.Config,
	ver string,
	hub *ws.Hub,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		clientAddr := clientIP(r)

		lkHealthy := false
		if ok, _ := hub.LiveKitHealthCheck(); ok {
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
			},
		}

		writeJSON(w, http.StatusOK, resp)
	}
}

// isPrivateIP checks if an IP string is in a private/reserved range.
func isPrivateIP(ip string) bool {
	for _, prefix := range []string{
		"10.", "172.16.", "172.17.", "172.18.", "172.19.",
		"172.20.", "172.21.", "172.22.", "172.23.", "172.24.",
		"172.25.", "172.26.", "172.27.", "172.28.", "172.29.",
		"172.30.", "172.31.", "192.168.", "127.", "::1", "fc", "fd",
	} {
		if len(ip) >= len(prefix) && ip[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}
