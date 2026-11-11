package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws"
)

// serverInfoResponse is GET /api/v1/server-info: public identity, compatibility, registration mode, the
// default message retention window and the upload transfer lifetime. ProtocolEpoch is here because a client
// must know whether it can speak to this server BEFORE opening a WebSocket. There is deliberately no
// version field: build identity stays off unauthenticated endpoints so a server cannot be matched against a
// CVE list, and an epoch does not leak that.
type serverInfoResponse struct {
	Name                 string           `json:"name"`
	ProtocolEpoch        int              `json:"protocol_epoch"`
	BrowserClientEnabled bool             `json:"browser_client_enabled"`
	RegistrationMode     string           `json:"registration_mode"`
	Retention            retentionSummary `json:"retention"`
	Upload               uploadSummary    `json:"upload"`
}

type retentionSummary struct {
	MessagesDays int `json:"messages_days"`
}

// uploadSummary lets a client size its transfer bound above the server's, so the server cuts a slow upload
// and its 408 reaches the user.
type uploadSummary struct {
	TransferLifetimeSeconds int64 `json:"transfer_lifetime_seconds"`
}

// uploadTransferLifetime is the lifetime handleUpload gives an upload under the current per-file cap.
func uploadTransferLifetime(svc *service.Services) time.Duration {
	var fileCap int64
	if svc.Uploads != nil {
		fileCap = svc.Uploads.MaxUploadBytes()
	}
	return transferLifetimeFor(uploadBodyCap(fileCap))
}

// liveServerName is the server_name setting, falling back to config.yaml's server.name when missing or
// blank; a read error is returned.
func liveServerName(ctx context.Context, cfg *config.Config, svc *service.Services) (string, error) {
	name, err := svc.Settings.ServerName(ctx)
	if err != nil {
		return "", fmt.Errorf("server name: %w", err)
	}
	if name == "" {
		return cfg.Server.Name, nil
	}
	return name, nil
}

const (
	// Like health, public and rate-limit-exempt; failures are cached too, so an outage cannot turn every
	// request into a settings read.
	serverInfoCacheTTL    = 5 * time.Second
	serverInfoReadTimeout = 1 * time.Second
)

func handleServerInfo(cfg *config.Config, svc *service.Services) http.HandlerFunc {
	var mu syncutil.Mutex
	var cachedAt time.Time
	var cached serverInfoResponse
	var cachedErr error
	return func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if time.Since(cachedAt) >= serverInfoCacheTTL {
			// The shared result must outlive a disconnected caller, but the settings reads keep a bounded
			// deadline.
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), serverInfoReadTimeout)
			cached, cachedErr = buildServerInfo(ctx, cfg, svc)
			cancel()
			cachedAt = time.Now()
			if cachedErr != nil {
				slog.Error("failed to read server info", "error", cachedErr)
			}
		}
		response, err := cached, cachedErr
		mu.Unlock()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "internal server error")
			return
		}
		writeJSON(w, http.StatusOK, response)
	}
}

func buildServerInfo(ctx context.Context, cfg *config.Config, svc *service.Services) (serverInfoResponse, error) {
	mode, err := svc.Settings.RegistrationMode(ctx)
	if err != nil {
		return serverInfoResponse{}, err
	}
	days, err := svc.Retention.ServerDays(ctx)
	if err != nil {
		return serverInfoResponse{}, err
	}
	name, err := liveServerName(ctx, cfg, svc)
	if err != nil {
		return serverInfoResponse{}, err
	}
	// No version, build or commit on an unauthenticated endpoint: that lets a scanner match the server to a
	// CVE list (TestAPIV1ServerInfoOmitsVersion enforces it). ws.ProtocolEpoch is GENERATED from
	// protocol/schema.json; read the constant, since a literal would go stale on the next bump. Reporting
	// BrowserClientEnabled is not hosting: the router mounts the portal routes.
	return serverInfoResponse{
		Name:                 name,
		ProtocolEpoch:        ws.ProtocolEpoch,
		BrowserClientEnabled: cfg.Server.BrowserClientEnabled,
		RegistrationMode:     string(mode),
		Retention:            retentionSummary{MessagesDays: days},
		Upload:               uploadSummary{TransferLifetimeSeconds: int64(uploadTransferLifetime(svc) / time.Second)},
	}, nil
}
