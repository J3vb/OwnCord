package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws"
)

// serverInfoResponse is the JSON shape returned by GET /api/v1/server-info
// (B6-7, B7-15a): public identity, compatibility, registration mode and the
// server-default message retention window.
//
// ProtocolEpoch is here because a client — a browser client above all — has to
// know whether it can speak to this server BEFORE it opens a WebSocket; without
// it the only way to find out is a rejected connection, which is the confusing
// failure B2-2 set out to remove.
//
// There is deliberately no version field. C-2 keeps build identity off every
// unauthenticated endpoint so a server cannot be matched against a CVE list;
// an epoch does not leak that (every 1.2.x server reports epoch 1). Version
// lives on the admin-gated diagnostics endpoint. See handleServerInfo.
type serverInfoResponse struct {
	Name                 string           `json:"name"`
	ProtocolEpoch        int              `json:"protocol_epoch"`
	BrowserClientEnabled bool             `json:"browser_client_enabled"`
	RegistrationMode     string           `json:"registration_mode"`
	Retention            retentionSummary `json:"retention"`
}

type retentionSummary struct {
	MessagesDays int `json:"messages_days"`
}

type serverInfoDeps struct {
	registrationMode func(context.Context) (service.RegistrationMode, error)
	retentionDays    func(context.Context) (int, error)
}

func routerServerInfoDeps(svc *service.Services) serverInfoDeps {
	return serverInfoDeps{
		registrationMode: svc.Settings.RegistrationMode,
		retentionDays:    svc.Retention.ServerDays,
	}
}

const (
	// Like health, server-info is public and rate-limit-exempt. Cache failures
	// too, so an outage cannot turn every request into another settings read.
	serverInfoCacheTTL    = 5 * time.Second
	serverInfoReadTimeout = 1 * time.Second
)

func handleServerInfo(cfg *config.Config, deps serverInfoDeps) http.HandlerFunc {
	var mu syncutil.Mutex
	var cachedAt time.Time
	var cached serverInfoResponse
	var cachedErr error
	return func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if time.Since(cachedAt) >= serverInfoCacheTTL {
			// The shared result must outlive a disconnected caller, but the
			// settings reads still have a bounded deadline, as health does.
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), serverInfoReadTimeout)
			cached, cachedErr = buildServerInfo(ctx, cfg, deps)
			cancel()
			cachedAt = time.Now()
			if cachedErr != nil {
				slog.Error("failed to read server info", "error", cachedErr)
			}
		}
		response, err := cached, cachedErr
		mu.Unlock()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
			return
		}
		writeJSON(w, http.StatusOK, response)
	}
}

func buildServerInfo(ctx context.Context, cfg *config.Config, deps serverInfoDeps) (serverInfoResponse, error) {
	mode, err := deps.registrationMode(ctx)
	if err != nil {
		return serverInfoResponse{}, err
	}
	days, err := deps.retentionDays(ctx)
	if err != nil {
		return serverInfoResponse{}, err
	}
	// C-2: no version, build or commit on an unauthenticated endpoint —
	// that is what lets a scanner match this server to a CVE list. If you
	// are here to add one, it belongs on the admin-gated diagnostics
	// endpoint instead (TestAPIV1ServerInfoOmitsVersion enforces this).
	//
	// ws.ProtocolEpoch is GENERATED from protocol/schema.json. Read the
	// constant; a literal would keep reporting the old number after the
	// next epoch bump and silently lie to every client.
	//
	// Reporting BrowserClientEnabled is not hosting: no route is mounted
	// and no asset is served either way (browser_hosting_posture_test.go).
	return serverInfoResponse{
		Name:                 cfg.Server.Name,
		ProtocolEpoch:        ws.ProtocolEpoch,
		BrowserClientEnabled: cfg.Server.BrowserClientEnabled,
		RegistrationMode:     string(mode),
		Retention:            retentionSummary{MessagesDays: days},
	}, nil
}
