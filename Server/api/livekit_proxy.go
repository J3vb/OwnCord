package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/httperr"
)

// NewLiveKitProxy creates a reverse proxy forwarding HTTP and WebSocket requests to LiveKit through
// OwnCord's HTTPS server, avoiding WebView2 mixed-content blocks.
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

	// Never forwarded (internal/admin endpoints); matched as exact path segments to avoid false positives
	// like "/user-metrics".
	blockedSegments := map[string]bool{"admin": true, "metrics": true, "debug": true, "twirp": true}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Enforced for EVERY request including WebSocket upgrades, or an Upgrade header would bypass the
		// blocklist.

		for seg := range strings.SplitSeq(strings.ToLower(r.URL.Path), "/") {
			if blockedSegments[seg] {
				writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "access denied")
				return
			}
		}

		// The proxy's only origin decision: proxyWebSocket's Accept skips its own check.
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

// The fixed webview origins of the desktop client (tauri.localhost on WebView2, tauri:// on
// WKWebView/WebKitGTK). The LiveKit JS SDK's signal requests come from the webview and DO carry them;
// without them voice fails with 403 on every default install for a client off the server machine. This does
// not widen the CSRF surface: a remote website cannot present these origins, so only code on the user's own
// machine could.
var firstPartyClientOrigins = []string{
	"http://tauri.localhost",
	"https://tauri.localhost",
	"tauri://localhost",
}

// stripDefaultPort removes a trailing ":443" (https) or ":80" (http) so an explicit default port and its
// RFC 6454 equivalent compare equal; a reverse proxy may normalize one side of an origin/host comparison
// but not the other.
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

// isOriginAllowed reports whether r's Origin is allowed. No Origin, a same-origin Host match and the
// first-party webview origins always pass; an empty allowedOrigins denies every other origin, and only
// "*" allows all.
func isOriginAllowed(r *http.Request, allowedOrigins []string) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // non-browser or same-origin requests
	}
	// Browsers attach the page's own origin to every WebSocket handshake; an Origin matching the request's
	// Host is same-origin, mirroring websocket.Accept's default policy. The browser pins Origin, so the CSRF
	// surface is unchanged.
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

func proxyWebSocket(w http.ResponseWriter, r *http.Request, target *url.URL) {
	backendURL := *target
	backendURL.Path = r.URL.Path
	backendURL.RawQuery = r.URL.RawQuery

	// Forward Authorization: the LiveKit Rust SDK (Linux native voice) sends its room-join token as a Bearer
	// header, not access_token. Nothing else is forwarded.
	var backendHeader http.Header
	authz := r.Header.Get("Authorization")
	if authz != "" {
		backendHeader = http.Header{"Authorization": {authz}}
	}

	// The dial has its own bound so a hung SFU cannot hold the handler; it bounds the handshake only.
	dialCtx, cancelDial := context.WithTimeout(r.Context(), time.Duration(wsProxyDialTimeout.Load()))
	defer cancelDial()
	backConn, dialResp, err := websocket.Dial(dialCtx, backendURL.String(), &websocket.DialOptions{
		HTTPHeader:   backendHeader,
		Subprotocols: r.Header.Values("Sec-WebSocket-Protocol"),
	})
	if dialResp != nil && dialResp.Body != nil {
		defer dialResp.Body.Close() //nolint:errcheck // best-effort close
	}
	if err != nil {
		// websocket.Dial wraps a *url.Error embedding the full request URL, including access_token, a live
		// LiveKit room-join JWT that anyone with log access (the admin ring buffer captures DEBUG+) could
		// replay within its 5-minute TTL. Strip the raw query first (so an encoded form is caught), then the
		// decoded token. The Authorization header carries the same JWT, so scrubbing it is future-proofing.
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
	// The library default (32 KiB) would tear down both legs on a large signaling frame before copyWS's own
	// limit.
	backConn.SetReadLimit(wsProxyMaxMessageSize)

	// isOriginAllowed already decided the Origin; Accept's own check would apply a second, different policy
	// and refuse requests the proxy admitted.
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

	// Cancellable so when one direction finishes, the other's copyWS is unblocked.
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

// wsProxyMaxMessageSize is the read limit of both legs; a larger message closes with
// StatusMessageTooBig. 256 KB is generous for LiveKit signalling (typically < 10 KB).
const wsProxyMaxMessageSize = 256 * 1024

// wsProxyDialTimeout bounds the backend WebSocket handshake (10 s); atomic so a test can shorten it.
var wsProxyDialTimeout atomic.Int64

func init() { wsProxyDialTimeout.Store(int64(10 * time.Second)) }

const wsCloseReasonMax = 123

// copyWS copies messages until an error or cancellation; the read limit on src prevents memory exhaustion.
func copyWS(ctx context.Context, dst, src *websocket.Conn) error {
	for {
		msgType, reader, err := src.Reader(ctx)
		if err != nil {
			forwardClose(dst, err)
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

// forwardClose relays the close frame one leg received to the other, so the LiveKit SDK sees the SFU's own
// code (for example the one that says not to reconnect). Non-close errors leave the deferred normal close.
func forwardClose(dst *websocket.Conn, err error) {
	ce, ok := errors.AsType[websocket.CloseError](err)
	if !ok || !sendableCloseCode(ce.Code) {
		return
	}
	_ = dst.Close(ce.Code, truncateCloseReason(ce.Reason)) //nolint:errcheck // best-effort; the other leg may already be gone
}

// sendableCloseCode reports whether code may appear in a close frame (RFC 6455 section 7.4).
func sendableCloseCode(code websocket.StatusCode) bool {
	if code == 1004 || code == websocket.StatusNoStatusRcvd || code == websocket.StatusAbnormalClosure || code == websocket.StatusTLSHandshake {
		return false
	}
	return (code >= websocket.StatusNormalClosure && code <= websocket.StatusBadGateway) || (code >= 3000 && code <= 4999)
}

// truncateCloseReason cuts reason to wsCloseReasonMax bytes on a rune boundary.
func truncateCloseReason(reason string) string {
	if len(reason) <= wsCloseReasonMax {
		return reason
	}
	cut := wsCloseReasonMax
	for cut > 0 && !utf8.RuneStart(reason[cut]) {
		cut--
	}
	return reason[:cut]
}
