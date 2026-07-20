package api

import (
	"context"
	"net/http"
)

// HandleMetricsForTest exposes handleMetrics for use in external tests.
var HandleMetricsForTest = handleMetrics

// HandleLiveKitHealthForTest exposes handleLiveKitHealth for use in external tests.
func HandleLiveKitHealthForTest(healthCheck func(context.Context) (bool, error)) http.HandlerFunc {
	// Inline the logic since handleLiveKitHealth requires a *ws.Hub.
	return func(w http.ResponseWriter, r *http.Request) {
		ok, err := healthCheck(r.Context())
		if ok {
			writeJSON(w, http.StatusOK, livekitHealthResponse{
				Status:           "ok",
				LiveKitReachable: true,
			})
			return
		}

		errMsg := "unknown"
		if err != nil {
			errMsg = err.Error()
		}
		writeJSON(w, http.StatusServiceUnavailable, livekitHealthResponse{
			Status:           "degraded",
			LiveKitReachable: false,
			Error:            errMsg,
		})
	}
}

// IsPrivateIPForTest exposes isPrivateIP for use in external tests.
var IsPrivateIPForTest = isPrivateIP

// SetGIFUpstreamForTest points the GIF proxy at a stub upstream and returns a
// restore func. The production transport uses the SSRF-guarded dialer, which
// refuses loopback addresses, so tests must supply their own client too.
func SetGIFUpstreamForTest(baseURL string, client *http.Client) func() {
	prevBase, prevClient := gifAPIBase, gifClient
	gifAPIBase, gifClient = baseURL, client
	return func() { gifAPIBase, gifClient = prevBase, prevClient }
}
