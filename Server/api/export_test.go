package api

import (
	"context"
	"net/http"

	"github.com/owncord/server/service"
	"github.com/owncord/server/ws"
)

// BroadcastDMOpenForTest exposes broadcastDMOpen for external tests.
func BroadcastDMOpenForTest(ctx context.Context, svc *service.Services, broadcaster DMBroadcaster, channelID int64, targetIDs []int64) {
	broadcastDMOpen(ctx, svc, broadcaster, channelID, targetIDs)
}

// HandleMetricsForTest exposes handleMetrics for use in external tests.
var HandleMetricsForTest = handleMetrics

// LiveKitHealthHandlerForTest exposes the real handleLiveKitHealth. Prefer it
// over HandleLiveKitHealthForTest, which only re-implements the same shape.
func LiveKitHealthHandlerForTest(hub *ws.Hub) http.HandlerFunc {
	return handleLiveKitHealth(hub)
}

// HandleLiveKitHealthForTest re-implements handleLiveKitHealth against a
// caller-supplied health check.
//
// It does NOT exercise the production handler — the body below is a copy, so
// the two can drift and every test built on this hook would keep passing.
// It survives only because its callers predate LiveKitHealthHandlerForTest;
// new tests should use that instead, and these callers should migrate.
func HandleLiveKitHealthForTest(healthCheck func(context.Context) (bool, error)) http.HandlerFunc {
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

// WebPDimensionsForTest exposes the hand-rolled WebP header reader. It has no
// standard-library counterpart to cross-check it against, so the chunk-flavour
// cases are tested directly rather than only through the upload handler.
var WebPDimensionsForTest = webpDimensions

// BroadcastEmojiSetForTest exposes broadcastEmojiSet for external tests.
func BroadcastEmojiSetForTest(ctx context.Context, svc *service.Services, broadcaster EmojiBroadcaster) {
	broadcastEmojiSet(ctx, svc, broadcaster)
}

// SetGIFUpstreamForTest points the GIF proxy at a stub upstream and returns a
// restore func. The production transport uses the SSRF-guarded dialer, which
// refuses loopback addresses, so tests must supply their own client too.
func SetGIFUpstreamForTest(baseURL string, client *http.Client) func() {
	prevBase, prevClient := gifAPIBase, gifClient
	gifAPIBase, gifClient = baseURL, client
	return func() { gifAPIBase, gifClient = prevBase, prevClient }
}

// SecurityHeaders is SecurityHeadersWithTLS with TLS disabled (no HSTS).
// Test-only convenience — production always goes through SecurityHeadersWithTLS.
func SecurityHeaders(next http.Handler) http.Handler {
	return SecurityHeadersWithTLS("")(next)
}
