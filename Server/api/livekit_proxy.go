package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"nhooyr.io/websocket"
)

// NewLiveKitProxy creates a reverse proxy handler that forwards both HTTP
// and WebSocket requests to the LiveKit server. This allows the client to
// reach LiveKit through OwnCord's existing HTTPS server, avoiding
// mixed-content blocks in WebView2 (secure page → insecure WebSocket).
//
// The client connects to wss://server:8443/livekit/ which is proxied to
// ws://localhost:7880/ on the LiveKit server.
func NewLiveKitProxy(livekitURL string, allowedOrigins []string) http.Handler {
	target, err := url.Parse(livekitURL)
	if err != nil {
		slog.Error("invalid LiveKit URL — falling back to localhost:7880",
			"url", livekitURL, "error", err)
		target, _ = url.Parse("http://localhost:7880")
	}

	// Normalise scheme for HTTP proxy target.
	httpTarget := *target
	switch httpTarget.Scheme {
	case "ws":
		httpTarget.Scheme = "http"
	case "wss":
		httpTarget.Scheme = "https"
	}

	// Normalise scheme for WebSocket proxy target.
	wsTarget := *target
	switch wsTarget.Scheme {
	case "http":
		wsTarget.Scheme = "ws"
	case "https":
		wsTarget.Scheme = "wss"
	}

	httpProxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = httpTarget.Scheme
			req.URL.Host = httpTarget.Host
			req.Host = httpTarget.Host
		},
	}

	// Paths that must never be forwarded to LiveKit (internal/admin endpoints).
	// Matched as exact path segments to avoid false positives (e.g. "/user-metrics").
	blockedSegments := map[string]bool{"admin": true, "metrics": true, "debug": true, "twirp": true}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Detect WebSocket upgrade requests.
		if isWebSocketUpgrade(r) {
			proxyWebSocket(w, r, &wsTarget, allowedOrigins)
			return
		}

		// Block sensitive LiveKit endpoints (exact segment match).
		for _, seg := range strings.Split(strings.ToLower(r.URL.Path), "/") {
			if blockedSegments[seg] {
				writeJSON(w, http.StatusForbidden, errorResponse{
					Error:   "FORBIDDEN",
					Message: "access denied",
				})
				return
			}
		}

		// Validate Origin header for HTTP requests (mirrors WS OriginPatterns).
		if !isOriginAllowed(r, allowedOrigins) {
			writeJSON(w, http.StatusForbidden, errorResponse{
				Error:   "FORBIDDEN",
				Message: "access denied",
			})
			return
		}

		httpProxy.ServeHTTP(w, r)
	})
}

func isWebSocketUpgrade(r *http.Request) bool {
	for _, v := range r.Header.Values("Connection") {
		if strings.EqualFold(strings.TrimSpace(v), "upgrade") {
			return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
		}
	}
	return false
}

// isOriginAllowed checks whether the request's Origin header matches one of the
// allowed origins. Requests with no Origin header (e.g. same-origin or non-browser)
// are permitted. An empty allowedOrigins list denies all cross-origin requests
// (require explicit "*" wildcard to allow all).
func isOriginAllowed(r *http.Request, allowedOrigins []string) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // non-browser or same-origin requests
	}
	if len(allowedOrigins) == 0 {
		return false // no allowlist configured — deny cross-origin
	}
	for _, pattern := range allowedOrigins {
		if pattern == "*" {
			return true
		}
		if strings.EqualFold(origin, pattern) {
			return true
		}
	}
	return false
}

// proxyWebSocket opens a backend WS connection and shovels data in both
// directions until either side closes.
func proxyWebSocket(w http.ResponseWriter, r *http.Request, target *url.URL, allowedOrigins []string) {
	// Build backend URL preserving the request path and query.
	backendURL := *target
	backendURL.Path = r.URL.Path
	backendURL.RawQuery = r.URL.RawQuery

	// Connect to LiveKit backend.
	backConn, _, err := websocket.Dial(r.Context(), backendURL.String(), &websocket.DialOptions{
		Subprotocols: r.Header.Values("Sec-WebSocket-Protocol"),
	})
	if err != nil {
		slog.Warn("livekit proxy: backend dial failed", "host", backendURL.Host, "path", backendURL.Path, "err", err)
		writeJSON(w, http.StatusBadGateway, errorResponse{
			Error:   "BAD_GATEWAY",
			Message: "backend unavailable",
		})
		return
	}
	defer backConn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best-effort close on defer

	// Accept the frontend WebSocket.
	frontConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:   []string{backConn.Subprotocol()},
		OriginPatterns: allowedOrigins,
	})
	if err != nil {
		slog.Warn("livekit proxy: frontend accept failed", "err", err)
		return
	}
	defer frontConn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best-effort close on defer

	// Use a cancellable context so when one direction finishes, the other
	// goroutine's copyWS read/write is unblocked and can drain cleanly.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	errc := make(chan error, 2)

	// Frontend → Backend
	go func() {
		errc <- copyWS(ctx, backConn, frontConn)
	}()

	// Backend → Frontend
	go func() {
		errc <- copyWS(ctx, frontConn, backConn)
	}()

	// Wait for either direction to finish, then cancel+drain both.
	<-errc
	cancel()
	<-errc
}

// copyWS reads messages from src and writes them to dst until an error or
// context cancellation.
func copyWS(ctx context.Context, dst, src *websocket.Conn) error {
	for {
		msgType, reader, err := src.Reader(ctx)
		if err != nil {
			return err
		}
		writer, err := dst.Writer(ctx, msgType)
		if err != nil {
			return err
		}
		if _, err = io.Copy(writer, reader); err != nil {
			return err
		}
		if err = writer.Close(); err != nil {
			return err
		}
	}
}
