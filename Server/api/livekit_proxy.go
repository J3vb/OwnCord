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
func NewLiveKitProxy(livekitURL string) http.Handler {
	target, err := url.Parse(livekitURL)
	if err != nil {
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

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Detect WebSocket upgrade requests.
		if isWebSocketUpgrade(r) {
			proxyWebSocket(w, r, &wsTarget)
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

// proxyWebSocket opens a backend WS connection and shovels data in both
// directions until either side closes.
func proxyWebSocket(w http.ResponseWriter, r *http.Request, target *url.URL) {
	// Build backend URL preserving the request path and query.
	backendURL := *target
	backendURL.Path = r.URL.Path
	backendURL.RawQuery = r.URL.RawQuery

	// Connect to LiveKit backend.
	backConn, _, err := websocket.Dial(r.Context(), backendURL.String(), &websocket.DialOptions{
		Subprotocols: r.Header.Values("Sec-WebSocket-Protocol"),
	})
	if err != nil {
		slog.Warn("livekit proxy: backend dial failed", "url", backendURL.String(), "err", err)
		http.Error(w, "backend unavailable", http.StatusBadGateway)
		return
	}
	defer backConn.Close(websocket.StatusNormalClosure, "")

	// Accept the frontend WebSocket.
	frontConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:   []string{backConn.Subprotocol()},
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		slog.Warn("livekit proxy: frontend accept failed", "err", err)
		return
	}
	defer frontConn.Close(websocket.StatusNormalClosure, "")

	ctx := r.Context()
	errc := make(chan error, 2)

	// Frontend → Backend
	go func() {
		errc <- copyWS(ctx, backConn, frontConn)
	}()

	// Backend → Frontend
	go func() {
		errc <- copyWS(ctx, frontConn, backConn)
	}()

	// Wait for either direction to finish.
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
