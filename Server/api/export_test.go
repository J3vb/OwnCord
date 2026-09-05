package api

import (
	"context"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"

	"github.com/J3vb/OwnCord/Server/safefetch"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
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
// restore func.
//
// The stub is an httptest server on loopback over plain http, and the
// production policy refuses both, so the test fetcher relaxes exactly two
// things — the scheme/port pair and the loopback classification — and keeps
// every ceiling, the redirect budget and the content-type allowlist as
// production has them. Nothing outside a _test.go file may set
// safefetch.Policy.Classify; TestNoProductionOverrideOfSeams enforces that.
func SetGIFUpstreamForTest(baseURL string) (func(), error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		return nil, fmt.Errorf("stub upstream %q has no port: %w", baseURL, err)
	}
	policy := safefetch.Policy{
		Schemes:              []string{u.Scheme},
		Ports:                []int{port},
		ContentTypes:         []string{"application/json", "text/plain"},
		MaxRedirects:         0,
		Deadline:             gifUpstreamTimeout,
		MaxBytes:             gifMaxResponseBytes,
		MaxDecompressedBytes: gifMaxResponseBytes,
		MaxConcurrent:        gifMaxConcurrentUpstream,
		Classify: func(addr netip.Addr) error {
			if addr.Unmap().IsLoopback() {
				return nil
			}
			return safefetch.ClassifyAddr(addr)
		},
	}
	stub, err := safefetch.New(policy)
	if err != nil {
		return nil, err
	}
	prevBase, prevFetcher := gifAPIBase, gifFetcher
	gifAPIBase, gifFetcher = baseURL, stub
	return func() { gifAPIBase, gifFetcher = prevBase, prevFetcher }, nil
}

// SetGIFBaseURLForTest points the GIF proxy at a stub upstream while leaving
// the production Fetcher in place, so a test can show that the real policy
// refuses what the relaxed one reaches.
func SetGIFBaseURLForTest(baseURL string) func() {
	prev := gifAPIBase
	gifAPIBase = baseURL
	return func() { gifAPIBase = prev }
}

// SetGIFResolveForTest swaps only the GIF Fetcher's Resolve seam, keeping
// every ceiling — scheme, port, deadline, byte limits, content types,
// concurrency — identical to production, and gifAPIBase untouched (a request
// whose Resolve fails never dials, so there is no need of a stub upstream
// URL). For tests that want a deterministic resolve failure without touching
// real DNS, which a DNS-impaired runner can retry for several seconds.
// Nothing outside a _test.go file may set safefetch.Policy.Resolve;
// TestNoProductionOverrideOfSeams enforces that.
func SetGIFResolveForTest(resolve func(ctx context.Context, host string) ([]netip.Addr, error)) (func(), error) {
	stub, err := safefetch.New(safefetch.Policy{
		Schemes:              []string{"https"},
		Ports:                []int{443},
		ContentTypes:         []string{"application/json", "text/plain"},
		MaxRedirects:         0,
		Deadline:             gifUpstreamTimeout,
		MaxBytes:             gifMaxResponseBytes,
		MaxDecompressedBytes: gifMaxResponseBytes,
		MaxConcurrent:        gifMaxConcurrentUpstream,
		Resolve:              resolve,
	})
	if err != nil {
		return nil, err
	}
	prev := gifFetcher
	gifFetcher = stub
	return func() { gifFetcher = prev }, nil
}

// SecurityHeaders is SecurityHeadersWithTLS with TLS disabled (no HSTS).
// Test-only convenience — production always goes through SecurityHeadersWithTLS.
func SecurityHeaders(next http.Handler) http.Handler {
	return SecurityHeadersWithTLS("")(next)
}
