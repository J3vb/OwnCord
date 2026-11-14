// Package api provides the HTTP router and handlers for the OwnCord server.
package api

import (
	"errors"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/clientip"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/netclass"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/stackutil"
	"github.com/J3vb/OwnCord/Server/telemetry"
	"github.com/J3vb/OwnCord/Server/webclient"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// warnOnServerConfig logs settings that are legal but rarely what an operator meant. Warnings only: a
// questionable value must not stop a server that was working yesterday.
func warnOnServerConfig(cfg *config.Config) {
	// A wildcard origin accepts every browser page on the internet.
	if slices.Contains(cfg.Server.AllowedOrigins, "*") {
		slog.Warn("AllowedOrigins contains wildcard '*' — consider restricting to specific origins for production use")
	}
	_, bundled := webclient.Assets()
	warnOnBrowserClient(cfg, bundled)
	warnOnVoiceNodeIP(cfg)
	if cfg.Voice.LiveKitURL != "" && cfg.Voice.NodeIP != "" && cfg.Voice.AdvertiseInternalIP {
		slog.Warn("voice.node_ip is ignored while voice.advertise_internal_ip is on — LiveKit detects its public address over STUN instead",
			"node_ip", cfg.Voice.NodeIP,
			"fix", "clear voice.node_ip, or turn voice.advertise_internal_ip off if the pinned address must be advertised")
	}
	warnOnAdminPeerAddress(cfg)
}

// warnOnVoiceNodeIP warns about a voice.node_ip that remote clients cannot route to. It is the external
// address LiveKit advertises in ICE candidates, validated only for YAML-unsafe characters; a private, CGNAT
// or loopback address fails invisibly (joins succeed but no media arrives). It never refuses: a LAN-only or
// tailnet-only deployment may advertise a private address.
func warnOnVoiceNodeIP(cfg *config.Config) {
	if cfg.Voice.LiveKitURL == "" || cfg.Voice.NodeIP == "" {
		return
	}
	kind := classifyIP(cfg.Voice.NodeIP)
	if kind == netclass.KindGlobal {
		return
	}
	slog.Warn("voice.node_ip is not a public address — remote clients will join voice and then hear no audio",
		"node_ip", cfg.Voice.NodeIP,
		"address_class", kind,
		"why", "node_ip is the address LiveKit advertises in ICE candidates. A client outside this "+
			"network cannot route to it, so the call connects over signalling and carries no media",
		"fix", "clear voice.node_ip so LiveKit detects this server's public address (or set it to "+
			"that address) and forward UDP "+netclass.VoiceUDPLabel(cfg.Voice.UDPPort)+" — "+
			"see docs/port-forwarding.md. Ignore this if every client is on the LAN or your tailnet")
}

// NewRouter builds the HTTP handler and a cleanup function stopping background goroutines. pluginRegistry
// may be nil: plugin lifecycle endpoints then answer 503.
func NewRouter(cfg *config.Config, database *db.DB, ver string, logBuf *admin.RingBuffer, pluginRegistry *plugin.Registry, rt Runtime) (http.Handler, func()) {
	setAuthRateScale(cfg.Security.AuthRateLimitMultiplier)

	requireBuiltRuntime(rt)

	r := chi.NewRouter()

	slowRoutes := metrics.NewSlowRoutes(time.Now)
	routerMiddleware(r, cfg, slowRoutes)

	// One handler instance backs both /health mounts so they share the check cache; the hub-backed probes are
	// late-bound.
	var getOnlineUsers func() int
	var hubAlive func() bool
	healthHandler := handleHealth(routerHealthDeps(cfg, database, &getOnlineUsers, &hubAlive))
	r.Get("/health", healthHandler)
	mountPublicV1(r, cfg, healthHandler, rt.Services)

	hub := rt.Hub
	getOnlineUsers = func() int { return hub.UserCount() }
	hubAlive = func() bool { return hub.DispatchAlive() }

	d := newRouteDeps(cfg, database, ver, logBuf, pluginRegistry, rt, slowRoutes)
	for _, g := range routeGroups {
		g.mount(r, d)
	}

	warnOnServerConfig(cfg)

	return r, func() {}
}

// routerMiddleware installs the global middleware stack. The order is a security property (request-id
// before the logger, tracing before panic recovery, security headers and the body cap before any handler) —
// keep it exactly as written.
func routerMiddleware(r chi.Router, cfg *config.Config, slow *metrics.SlowRoutes) {
	r.Use(boundRequestID) // must precede RequestID — it reads the header verbatim
	r.Use(middleware.RequestID)
	r.Use(setRequestIDHeader) // echo request ID into response header
	// middleware.RealIP is intentionally omitted: trusting X-Real-IP from any source allows IP spoofing for
	// rate-limit bypass; clientip.Resolve applies trusted_proxies. HTTP tracing is mounted ahead of
	// recoverer, which snapshots the trace id before dispatch.
	r.Use(telemetry.HTTPMiddleware())
	r.Use(recoverer) // slog-routing panic recovery (replaces chi's stderr-only Recoverer)
	// The access log is proxy-aware so a reverse-proxy deployment records the real client; parsed once, never
	// per request.
	proxyNets := parseCIDRList(cfg.Server.TrustedProxies)
	r.Use(requestLogger(proxyNets, slow)) // structured request/response logging
	r.Use(SecurityHeadersWithTLS(cfg.TLS.Mode))
	r.Use(MaxBodySizeUnless(defaultMaxBodySize, bodyCapExemptPattern, bodyCapExemptPrefixes...))
	r.Use(requestDeadlineMiddleware()) // 15 s deadline on non-streaming routes

	if cfg.Server.WAFEnabled {
		r.Use(NewWAFMiddlewareCRS(cfg.Server.WAFParanoiaLevel, cfg.Server.WAFCRSMode))
	}
}

// boundRequestID drops a client-supplied X-Request-Id over maxRequestIDLen bytes or not plain printable
// ASCII, so middleware.RequestID generates one. Otherwise a burst of ~1 MiB ids pins hundreds of MB of heap
// in the ring buffer. It drops rather than truncates: a truncated id correlates with nothing yet still
// parks attacker-chosen bytes in the log.
func boundRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id := r.Header.Get(middleware.RequestIDHeader); id != "" && !validRequestID(id) {
			r.Header.Del(middleware.RequestIDHeader)
		}
		next.ServeHTTP(w, r)
	})
}

func validRequestID(id string) bool {
	if len(id) > maxRequestIDLen {
		return false
	}
	for i := range len(id) {
		if id[i] < '!' || id[i] > '~' {
			return false
		}
	}
	return true
}

func setRequestIDHeader(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := middleware.GetReqID(r.Context())
		if requestID != "" {
			w.Header().Set("X-Request-Id", requestID)
		}
		next.ServeHTTP(w, r)
	})
}

// recoverer logs handler panics through slog so they reach the admin log stream. The stack comes from
// stackutil so it never embeds argument values, which can carry tokens or passwords.
func recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Capture correlation IDs before dispatch so the recovery closure makes no context calls
		// (contextcheck in a defer).
		reqID := middleware.GetReqID(r.Context())
		traceID := telemetry.TraceIDFromContext(r.Context())
		defer func() {
			if rec := recover(); rec != nil {
				if err, ok := rec.(error); ok && errors.Is(err, http.ErrAbortHandler) {
					panic(rec)
				}
				attrs := []any{
					"method", r.Method,
					"path", truncateForLog(r.URL.Path, maxLoggedPathLen),
					"panic", rec,
					"stack", stackutil.Capture(),
				}
				if reqID != "" {
					attrs = append(attrs, "req_id", reqID)
				}
				if traceID != "" {
					attrs = append(attrs, "trace_id", traceID)
				}
				slog.Error("http handler panic recovered", attrs...)
				// On Windows a nil deref or invalid address may have left the heap corrupt, so exit for a
				// supervisor restart rather than continue on damaged memory. Every other panic stays
				// recovered.
				if stackutil.Recovered(rec) {
					slog.Error("http handler: hardware fault, exiting for supervisor restart",
						"method", r.Method, "path", truncateForLog(r.URL.Path, maxLoggedPathLen))
					stackutil.Fatal()
				}
				w.WriteHeader(http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// requestLogger logs every HTTP request. Health checks and successful admin panel reads go to Debug (the
// panel polls its own API and would bury real events); admin writes stay at Info, and 4xx/5xx keep
// Warn/Error even under the admin prefix. It feeds slow (nil skips it) with route pattern and time, leaving
// out routes the request deadline exempts, whose time says nothing about slowness. proxyNets is parsed once
// at construction.
func requestLogger(proxyNets []*net.IPNet, slow *metrics.SlowRoutes) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)
			elapsed := time.Since(start)
			status := ww.Status()
			if slow != nil && !requestDeadlineExemptRequest(r.Method, r.URL.EscapedPath()) {
				if rctx := chi.RouteContext(r.Context()); rctx != nil {
					slow.Observe(r.Method, rctx.RoutePattern(), elapsed)
				}
			}

			path := r.URL.Path
			reqID := middleware.GetReqID(r.Context())
			attrs := []any{
				"method", r.Method,
				"path", truncateForLog(path, maxLoggedPathLen),
				"status", status,
				"duration_ms", elapsed.Milliseconds(),
				"bytes", ww.BytesWritten(),
				"client_ip", clientip.Resolve(r, proxyNets),
			}
			if reqID != "" {
				attrs = append(attrs, "req_id", reqID)
			}
			switch {
			case path == "/health" || path == "/api/v1/health":
				slog.Debug("http request", attrs...)
			case status < 400 && (r.Method == http.MethodGet || r.Method == http.MethodHead) && strings.HasPrefix(path, "/admin/api/"):
				slog.Debug("http request", attrs...)
			case status >= 500:
				slog.Error("http request", attrs...)
			case status >= 400:
				slog.Warn("http request", attrs...)
			default:
				slog.Info("http request", attrs...)
			}
		})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	httperr.WriteJSON(w, status, v)
}
