package api

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
)

const voiceCredentialTTL = 24 * time.Hour

// iceServer describes a single ICE server entry for WebRTC peer connections.
type iceServer struct {
	URLs       string `json:"urls"`
	Username   string `json:"username,omitempty"`
	Credential string `json:"credential,omitempty"`
}

// voiceCredentialsResponse is the JSON body for GET /api/v1/voice/credentials.
type voiceCredentialsResponse struct {
	ICEServers []iceServer `json:"ice_servers"`
	ExpiresIn  int         `json:"expires_in"`
}

// turnCredentials holds the generated TURN username and HMAC credential.
type turnCredentials struct {
	Username   string
	Credential string
}

// MountVoiceRoutes registers the voice REST endpoints on r.
func MountVoiceRoutes(r chi.Router, cfg *config.Config, database *db.DB) {
	r.Route("/api/v1/voice", func(r chi.Router) {
		r.Use(AuthMiddleware(database))
		r.Get("/credentials", handleVoiceCredentials(cfg, database))
	})
}

// handleVoiceCredentials returns ICE server credentials for WebRTC.
// Requires a valid session (AuthMiddleware). Generates time-limited TURN
// credentials using HMAC-SHA1 as per the coturn REST API spec.
func handleVoiceCredentials(cfg *config.Config, _ *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "authentication required",
			})
			return
		}

		host := serverHost(r)
		servers := buildICEServers(user.ID, cfg, host)

		writeJSON(w, http.StatusOK, voiceCredentialsResponse{
			ICEServers: servers,
			ExpiresIn:  int(voiceCredentialTTL.Seconds()),
		})
	}
}

// buildICEServers constructs the ICE server list for the given user.
func buildICEServers(userID int64, cfg *config.Config, host string) []iceServer {
	servers := []iceServer{
		{URLs: fmt.Sprintf("stun:%s:%d", host, cfg.Voice.STUNPort)},
	}

	if cfg.Voice.TURNEnabled && cfg.Voice.TURNSecret != "" {
		creds := generateTURNCredentials(userID, cfg.Voice.TURNSecret)
		servers = append(servers, iceServer{
			URLs:       fmt.Sprintf("turn:%s:%d", host, cfg.Voice.TURNPort),
			Username:   creds.Username,
			Credential: creds.Credential,
		})
	}

	return servers
}

// generateTURNCredentials produces time-limited TURN credentials using HMAC-SHA1.
// Username format: "<expiry_unix_timestamp>:<userID>"
// Credential: base64(HMAC-SHA1(secret, username))
func generateTURNCredentials(userID int64, secret string) turnCredentials {
	expiry := time.Now().Add(voiceCredentialTTL).Unix()
	username := fmt.Sprintf("%d:%d", expiry, userID)

	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(username))
	credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	return turnCredentials{
		Username:   username,
		Credential: credential,
	}
}

// serverHost extracts the host for ICE server URLs from the request or falls
// back to "localhost".
func serverHost(r *http.Request) string {
	if host := r.Host; host != "" {
		// Strip port if present.
		for i := len(host) - 1; i >= 0; i-- {
			if host[i] == ':' {
				return host[:i]
			}
			if host[i] == ']' {
				// IPv6 with no port.
				return host
			}
		}
		return host
	}
	return "localhost"
}
