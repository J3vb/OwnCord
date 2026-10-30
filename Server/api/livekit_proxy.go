package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/httperr"
)

// NewLiveKitProxy creates a reverse proxy forwarding HTTP and WebSocket requests
// to the LiveKit server, so the client reaches LiveKit through OwnCord's HTTPS
// server and avoids WebView2 mixed-content blocks: wss://server:8443/livekit/ is
// proxied to ws://localhost:7880/.
func NewLiveKitProxy(livekitURL string, allowedOrigins []string) http.Handler {
	target, err := url.Parse(livekitURL)
	if err != nil {
		slog.Error("invalid LiveKit URL — falling back to localhost:7880",
			"url", livekitURL, "error", err)
		target, _ = url.Parse("http://localhost:7880")
	}

	httpTarget := *target
	switch httpTarget.Scheme {
	case "ws":
		httpTarget.Scheme = "http"
	case "wss":
		httpTarget.Scheme = "https"
	}

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
		// Enforce the path allowlist and Origin check for EVERY request,
		// including WebSocket upgrades — otherwise a client could reach a
		// blocked/admin endpoint simply by sending an Upgrade header.

		for seg := range strings.SplitSeq(strings.ToLower(r.URL.Path), "/") {
			if blockedSegments[seg] {
				writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "access denied")
				return
			}
		}

		// Validate Origin header. This is the proxy's only origin decision:
		// proxyWebSocket's Accept skips its own check.
		if !isOriginAllowed(r, allowedOrigins) {
			slog.Warn("livekit proxy: origin rejected",
				"origin", r.Header.Get("Origin"), "path", r.URL.Path, "remote", r.RemoteAddr)
			writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "access denied")
			return
		}

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

// firstPartyClientOrigins are the fixed webview origins of the desktop client
// (Tauri): http(s)://tauri.localhost on WebView2, the tauri:// scheme on
// WKWebView/WebKitGTK. The chat connection goes through the Rust proxy (no
// Origin), but the LiveKit JS SDK's signal requests and validate probes come
// from the webview and DO carry these origins; without them voice fails with 403
// on every default install (empty allowed_origins) for any client off the server
// machine.
// This matches the trust already given to absent-Origin requests and does not
// widen the CSRF surface: a remote website cannot present these origins
// (browsers resolve *.localhost to loopback, tauri:// is unreachable from web
// content), so only code on the user's own machine could send them.
var firstPartyClientOrigins = []string{
	"http://tauri.localhost",
	"https://tauri.localhost",
	"tauri://localhost",
}

// isOriginAllowed checks whether the request's Origin header matches one of
// the allowed origins. Requests with no Origin header (e.g. same-origin or
// non-browser) and the first-party desktop client's webview origins are
// always permitted. Beyond those, an empty allowedOrigins list denies all
// cross-origin requests (require explicit "*" wildcard to allow all).
// stripDefaultPort removes a trailing ":443" (https) or ":80" (http) from
// host, so an explicit default port and its implicit RFC 6454 equivalent
// compare equal. A reverse proxy in front of the server may normalize one
// side (nginx's $host strips the port) but not the other (a client-set
// Origin keeps it), so both sides of an origin/host comparison need this.
func stripDefaultPort(scheme, host string) string {
	switch scheme {
	case "https":
		return strings.TrimSuffix(host, ":443")
	case "http":
		return strings.TrimSuffix(host, ":80")
	default:
		return host
	}
}

func isOriginAllowed(r *http.Request, allowedOrigins []string) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // non-browser or same-origin requests
	}
	// Browsers attach the page's own origin to every WebSocket handshake. An
	// Origin whose host matches the request's Host is a page this server served:
	// same-origin. This mirrors websocket.Accept's default policy, which the
	// chat WS endpoint already applies; other origins cannot present it (the
	// browser pins Origin), so the CSRF surface is unchanged.
	if u, err := url.Parse(origin); err == nil && u.Host != "" && strings.EqualFold(stripDefaultPort(u.Scheme, u.Host), stripDefaultPort(u.Scheme, r.Host)) {
		return true
	}
	for _, firstParty := range firstPartyClientOrigins {
		if strings.EqualFold(origin, firstParty) {
			return true
		}
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
func proxyWebSocket(w http.ResponseWriter, r *http.Request, target *url.URL) {
	backendURL := *target
	backendURL.Path = r.URL.Path
	backendURL.RawQuery = r.URL.RawQuery

	// Forward the Authorization header: the LiveKit Rust SDK (the Linux
	// client's native voice) sends its room-join token as a Bearer header
	// rather than the access_token query parameter. Nothing else is forwarded.
	var backendHeader http.Header
	authz := r.Header.Get("Authorization")
	if authz != "" {
		backendHeader = http.Header{"Authorization": {authz}}
	}

	backConn, dialResp, err := websocket.Dial(r.Context(), backendURL.String(), &websocket.DialOptions{
		HTTPHeader:   backendHeader,
		Subprotocols: r.Header.Values("Sec-WebSocket-Protocol"),
	})
	if dialResp != nil && dialResp.Body != nil {
		defer dialResp.Body.Close() //nolint:errcheck // best-effort close
	}
	if err != nil {
		// websocket.Dial wraps a *url.Error that embeds the full request URL,
		// including the access_token query parameter, a live LiveKit room-join
		// JWT. Anyone with log access (the admin panel's ring buffer captures
		// DEBUG+ regardless of the stdout level) could replay it within its
		// 5-minute TTL as the victim's participant. Strip the credential before
		// the error reaches slog: the raw query blob first (so an encoded form
		// is caught), then the decoded token. The Authorization header carries
		// the same JWT for the native client; dial errors do not echo headers
		// today, so scrubbing it is future-proofing.
		safeErr := redactKey(err.Error(), backendURL.RawQuery)
		safeErr = redactKey(safeErr, backendURL.Query().Get("access_token"))
		safeErr = redactKey(safeErr, authz)
		_, bearer, _ := strings.Cut(authz, " ")
		safeErr = redactKey(safeErr, strings.TrimSpace(bearer))
		slog.Warn("livekit proxy: backend dial failed", "host", backendURL.Host, "path", backendURL.Path, "err", safeErr)
		writeErr(w, http.StatusBadGateway, httperr.CodeBadGateway, "backend unavailable")
		return
	}
	defer backConn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best-effort close on defer
	// The library default (32 KiB) would tear down both legs on a large
	// signaling frame before copyWS's own limit is reached.
	backConn.SetReadLimit(wsProxyMaxMessageSize)

	// Accept the frontend WebSocket. isOriginAllowed already decided the Origin;
	// letting Accept run its own check would apply a second, different policy
	// (literal Host comparison, no default-port equivalence, no first-party
	// client origins) and refuse requests the proxy admitted.
	frontConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:       []string{backConn.Subprotocol()},
		InsecureSkipVerify: true,
	})
	if err != nil {
		slog.Warn("livekit proxy: frontend accept failed", "err", err)
		return
	}
	defer frontConn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best-effort close on defer
	frontConn.SetReadLimit(wsProxyMaxMessageSize)

	// Use a cancellable context so when one direction finishes, the other
	// goroutine's copyWS read/write is unblocked and can drain cleanly.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	errc := make(chan error, 2)

	go func() {
		errc <- copyWS(ctx, backConn, frontConn)
	}()

	go func() {
		errc <- copyWS(ctx, frontConn, backConn)
	}()

	<-errc
	cancel()
	<-errc
}

// wsProxyMaxMessageSize is the largest WebSocket message the proxy forwards;
// both legs use it as their read limit, so a larger message closes the
// connection with StatusMessageTooBig. 256 KB is generous for LiveKit signalling
// (typically < 10 KB).
const wsProxyMaxMessageSize = 256 * 1024

// copyWS copies messages from src to dst until an error or context cancellation.
// The read limit on src (wsProxyMaxMessageSize) prevents memory exhaustion via
// oversized frames.
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
		if _, copyErr := io.Copy(writer, reader); copyErr != nil {
			return copyErr
		}
		if closeErr := writer.Close(); closeErr != nil {
			return closeErr
		}
	}
}
