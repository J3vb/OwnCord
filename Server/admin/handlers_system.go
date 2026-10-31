package admin

import (
	"context"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/sysstats"
)

// SystemSources feeds the Dashboard health row (GET /system/stats). Any nil
// field leaves its figures out of the answer, so tests and partial wirings
// stay cheap.
type SystemSources struct {
	// Sampler holds the CPU and memory history; the app runs it.
	Sampler *sysstats.Sampler
	// DiskSpace reads free and total bytes on the data volume.
	DiskSpace func() (free, total uint64, err error)
	// DiskMinFree is server.min_free_disk_mb in bytes; below it uploads are
	// refused, which the tile shows as low.
	DiskMinFree uint64
	// UploadBytes is every upload's size summed (cached by the database).
	UploadBytes func(context.Context) (int64, error)
	// Started is when the process started; zero leaves uptime out.
	Started time.Time
	// SlowRoutes holds request times per route for GET /system/slow-requests;
	// nil answers an empty list.
	SlowRoutes *metrics.SlowRoutes
}

// systemWindows are the history lengths the route serves.
var systemWindows = map[string]time.Duration{"1h": time.Hour, "6h": 6 * time.Hour, "24h": 24 * time.Hour}

// systemMaxPoints caps the series: a sparkline cannot show more.
const systemMaxPoints = 360

type systemStatsResponse struct {
	IntervalSeconds int     `json:"interval_seconds"`
	WindowSeconds   int     `json:"window_seconds"`
	UptimeSeconds   *int64  `json:"uptime_seconds"`
	OnlineUsers     int     `json:"online_users"`
	CPUCores        int     `json:"cpu_cores"`
	MemoryTotal     *uint64 `json:"memory_total"`
	MemoryScope     string  `json:"memory_scope,omitempty"`
	// Current is the newest sample, null before the first one.
	Current *sysstats.Point  `json:"current"`
	Series  []sysstats.Point `json:"series"`
	Disk    systemDisk       `json:"disk"`
}

type systemDisk struct {
	Free    *uint64 `json:"free"`
	Total   *uint64 `json:"total"`
	MinFree uint64  `json:"min_free"`
	Low     *bool   `json:"low"`
	Uploads *int64  `json:"uploads"`
}

// handleGetSystemStats serves the Dashboard health row: CPU, memory, disk and
// uptime now, plus the CPU and memory history over ?window= (1h, 6h or 24h;
// 1h when absent). Reading it costs no measurement: the sampler already holds
// the history, and the disk figure is one statfs.
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

// fillSystemDisk adds the figures it can read; a failed read stays null.
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

// slowRequestsLimit is how many routes the slow requests card lists.
const slowRequestsLimit = 10

type slowRequestsResponse struct {
	WindowSeconds int                   `json:"window_seconds"`
	Routes        []metrics.RouteTiming `json:"routes"`
}

// handleGetSlowRequests serves the Dashboard's slow requests card: the ten
// slowest route patterns over the last hour, by their 95th percentile time.
// Routes that stream or hold a connection open are never recorded (see
// api.requestLogger), and a route shows as its pattern, never a raw path.
func handleGetSlowRequests(src SystemSources) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, slowRequestsResponse{
			WindowSeconds: int(metrics.SlowRouteWindow / time.Second),
			Routes:        src.SlowRoutes.Slowest(slowRequestsLimit),
		})
	}
}
