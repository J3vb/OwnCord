package api

import (
	"net/http"
	"runtime"
	"time"
)

// ServerMetrics holds runtime metrics for the /api/v1/metrics endpoint.
type ServerMetrics struct {
	Uptime         string  `json:"uptime"`
	UptimeSeconds  float64 `json:"uptime_seconds"`
	GoRoutines     int     `json:"goroutines"`
	HeapAllocMB    float64 `json:"heap_alloc_mb"`
	HeapSysMB      float64 `json:"heap_sys_mb"`
	NumGC          uint32  `json:"num_gc"`
	ConnectedUsers int     `json:"connected_users"`
}

// handleMetrics returns an HTTP handler that reports runtime server metrics.
// getConnectedUsers is a callback to retrieve the current WebSocket client count.
func handleMetrics(getConnectedUsers func() int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)

		uptime := time.Since(serverStartTime)
		metrics := ServerMetrics{
			Uptime:         uptime.Truncate(time.Second).String(),
			UptimeSeconds:  uptime.Seconds(),
			GoRoutines:     runtime.NumGoroutine(),
			HeapAllocMB:    float64(m.HeapAlloc) / 1024 / 1024,
			HeapSysMB:      float64(m.HeapSys) / 1024 / 1024,
			NumGC:          m.NumGC,
			ConnectedUsers: getConnectedUsers(),
		}

		writeJSON(w, http.StatusOK, metrics)
	}
}
