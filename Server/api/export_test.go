package api

import "net/http"

// HandleMetricsForTest exposes handleMetrics for use in external tests.
var HandleMetricsForTest = handleMetrics

// HandleLiveKitHealthForTest exposes handleLiveKitHealth for use in external tests.
func HandleLiveKitHealthForTest(healthCheck func() (bool, error)) http.HandlerFunc {
	// Inline the logic since handleLiveKitHealth requires a *ws.Hub.
	return func(w http.ResponseWriter, r *http.Request) {
		ok, err := healthCheck()
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
