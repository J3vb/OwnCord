package admin

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/lkstats"
	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/sysstats"
)

// SystemSources feeds the Dashboard health row (GET /system/stats). A nil field leaves its figures out, so
// tests and partial wirings stay cheap.
type SystemSources struct {
	Sampler *sysstats.Sampler
	// LiveKit reads LiveKit's stats page; nil when voice is off.
	LiveKit   *lkstats.Sampler
	DiskSpace func() (free, total uint64, err error)
	// DiskMinFree is server.min_free_disk_mb in bytes; below it uploads are refused (the tile shows low).
	DiskMinFree uint64
	UploadBytes func(context.Context) (int64, error)
	Started     time.Time
	// SlowRoutes holds per-route request times; nil answers an empty list.
	SlowRoutes *metrics.SlowRoutes
	// Database feeds the database card; nil leaves it "not measured".
	Database         func(context.Context) (SystemDatabase, error)
	MaxWSConnections int
}

// mountSystemRoutes mounts the health row, LiveKit and slow-requests cards and the System health page: server
// health detail, View Diagnostics like the attention panel.
func mountSystemRoutes(r chi.Router, gates *gateRegistry, src SystemSources, hub HubBroadcaster, attention *service.AttentionService, audit voiceRestartAuditor, version string) {
	gates.route(r, gateViewDiagnostics, http.MethodGet, "/system/stats", handleGetSystemStats(src, hub))
	gates.route(r, gateViewDiagnostics, http.MethodGet, "/system/livekit", handleGetSystemLiveKit(src, hub))
	gates.route(r, gateViewDiagnostics, http.MethodGet, "/system/slow-requests", handleGetSlowRequests(src))
	gates.route(r, gateViewDiagnostics, http.MethodGet, "/system/health", handleGetSystemHealth(src, hub, attention, version, time.Now))
	// Waking a voice server that stopped restarting is gated like POST /restart.
	gates.route(r, gateManageConfig, http.MethodPost, "/system/livekit/restart", handleRestartLiveKit(audit, hub))
}

var systemWindows = map[string]time.Duration{"1h": time.Hour, "6h": 6 * time.Hour, "24h": 24 * time.Hour}

// systemMaxPoints caps the series: a sparkline cannot show more.
const systemMaxPoints = 360

type systemStatsResponse struct {
	IntervalSeconds int              `json:"interval_seconds"`
	WindowSeconds   int              `json:"window_seconds"`
	UptimeSeconds   *int64           `json:"uptime_seconds"`
	OnlineUsers     int              `json:"online_users"`
	CPUCores        int              `json:"cpu_cores"`
	MemoryTotal     *uint64          `json:"memory_total"`
	MemoryScope     string           `json:"memory_scope,omitempty"`
	Current         *sysstats.Point  `json:"current"`
	Series          []sysstats.Point `json:"series"`
	Disk            systemDisk       `json:"disk"`
}

type systemDisk struct {
	Free    *uint64 `json:"free"`
	Total   *uint64 `json:"total"`
	MinFree uint64  `json:"min_free"`
	Low     *bool   `json:"low"`
	Uploads *int64  `json:"uploads"`
}

// handleGetSystemStats serves the health row: CPU, memory, disk and uptime now, plus CPU/memory history over
// ?window= (1h, 6h, 24h; default 1h). It costs no measurement: the sampler holds the history and disk is one
// statfs.
func handleGetSystemStats(src SystemSources, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.Query().Get("window")
		if key == "" {
			key = "1h"
		}
		window, ok := systemWindows[key]
		if !ok {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "window must be 1h, 6h or 24h")
			return
		}
		resp := systemStatsResponse{
			IntervalSeconds: int(sysstats.Interval / time.Second),
			WindowSeconds:   int(window / time.Second),
			CPUCores:        sysstats.Cores(),
			Series:          []sysstats.Point{},
			Disk:            systemDisk{MinFree: src.DiskMinFree},
		}
		if !src.Started.IsZero() {
			up := int64(time.Since(src.Started) / time.Second)
			resp.UptimeSeconds = &up
		}
		if hub != nil {
			resp.OnlineUsers = hub.UserCount()
		}
		if src.Sampler != nil {
			snap := src.Sampler.Snapshot(window, systemMaxPoints)
			resp.CPUCores, resp.Series, resp.MemoryScope = snap.Cores, snap.Points, snap.MemScope
			if snap.OK {
				resp.Current = &snap.Latest
			}
			if snap.MemTotal > 0 {
				resp.MemoryTotal = &snap.MemTotal
			}
		}
		fillSystemDisk(r.Context(), &resp.Disk, src)
		writeJSON(w, http.StatusOK, resp)
	}
}

func fillSystemDisk(ctx context.Context, d *systemDisk, src SystemSources) {
	if src.DiskSpace != nil {
		if free, total, err := src.DiskSpace(); err == nil {
			d.Free, d.Total = &free, &total
			if src.DiskMinFree > 0 {
				low := free < src.DiskMinFree
				d.Low = &low
			}
		}
	}
	if src.UploadBytes != nil {
		if n, err := src.UploadBytes(ctx); err == nil {
			d.Uploads = &n
		}
	}
}

const slowRequestsLimit = 10

type slowRequestsResponse struct {
	WindowSeconds int                   `json:"window_seconds"`
	Routes        []metrics.RouteTiming `json:"routes"`
}

// handleGetSlowRequests lists the ten slowest route patterns over the last hour by p95. Streaming or
// long-held routes are never recorded (see api.requestLogger), and routes show as patterns, never raw paths.
func handleGetSlowRequests(src SystemSources) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, slowRequestsResponse{
			WindowSeconds: int(metrics.SlowRouteWindow / time.Second),
			Routes:        src.SlowRoutes.Slowest(slowRequestsLimit),
		})
	}
}

type systemLiveKitResponse struct {
	Configured bool `json:"configured"`
	// Managed is set only when not configured: OwnCord runs its own LiveKit, which has no stats page to read.
	Managed *bool `json:"managed,omitempty"`
	// Source is "managed" (OwnCord's own LiveKit, read via the OS) or "metrics" (its stats page).
	Source          string          `json:"source,omitempty"`
	Status          string          `json:"status,omitempty"`
	Since           *int64          `json:"since,omitempty"`
	IntervalSeconds int             `json:"interval_seconds,omitempty"`
	WindowSeconds   int             `json:"window_seconds,omitempty"`
	Current         *lkstats.Point  `json:"current,omitempty"`
	Series          []lkstats.Point `json:"series,omitempty"`
}

// handleGetSystemLiveKit serves the LiveKit card: the last stats-page read and history over ?window=. It
// reads the sampler's ring and contacts nothing.
func handleGetSystemLiveKit(src SystemSources, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.Query().Get("window")
		if key == "" {
			key = "1h"
		}
		window, ok := systemWindows[key]
		if !ok {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "window must be 1h, 6h or 24h")
			return
		}
		if src.LiveKit == nil {
			managed := false
			if v, ok := hub.(supportHubVoice); ok {
				managed = v.LiveKitManaged()
			}
			writeJSON(w, http.StatusOK, systemLiveKitResponse{Managed: &managed})
			return
		}
		snap := src.LiveKit.Snapshot(window, systemMaxPoints)
		resp := systemLiveKitResponse{
			Configured:      true,
			Source:          snap.Source,
			Status:          string(snap.Status),
			IntervalSeconds: int(lkstats.Interval / time.Second),
			WindowSeconds:   int(window / time.Second),
			Series:          snap.Points,
		}
		if !snap.Since.IsZero() {
			since := snap.Since.Unix()
			resp.Since = &since
		}
		if snap.OK {
			resp.Current = &snap.Latest
		}
		writeJSON(w, http.StatusOK, resp)
	}
}
