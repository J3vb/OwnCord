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
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/ws"
)

// VoiceSessionGate admits one signalling request before the proxy dials the media server. presented is the
// credential the client sent; the ticket carries the one the proxy connects with. ws.Hub.AdmitVoiceSession
// is the production gate.
type VoiceSessionGate func(ctx context.Context, presented string) (ws.VoiceSessionTicket, error)

// liveKitSignalPaths are the only paths the proxy forwards, matched exactly. The value says whether the
// path opens a session, which only a WebSocket upgrade does; the other two answer a plain GET.
var liveKitSignalPaths = map[string]bool{
	"/rtc":             true,
	"/rtc/v1":          true,
	"/rtc/validate":    false,
	"/rtc/v1/validate": false,
}

const (
	liveKitAccessTokenParam = "access_token"
	liveKitBearerPrefix     = "Bearer "
	corsAllowOriginHeader   = "Access-Control-Allow-Origin"
)

// wsProxyConfirmTimeout bounds the ticket's Confirm step, which runs between the backend dial and the
// client's upgrade.
const wsProxyConfirmTimeout = 10 * time.Second

// wsProxyLeaveWait bounds the wait for LiveKit's first message when it holds no participant.
const wsProxyLeaveWait = 2 * time.Second

// NewLiveKitProxy creates a reverse proxy forwarding LiveKit signalling through OwnCord's HTTPS server,
// avoiding WebView2 mixed-content blocks. Every request passes gate first and reaches LiveKit with the
// gate's credential, never the client's.
func NewLiveKitProxy(livekitURL string, allowedOrigins []string, gate VoiceSessionGate) http.Handler {
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

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Enforced for EVERY request including WebSocket upgrades, or an Upgrade header would bypass the
		// path list. LiveKit's API, admin, metrics and ingest endpoints are not on it. A session path is
		// served only as a WebSocket and a validate path never as one. The refusal is a 403: the LiveKit
		// SDK reads a 404 as "this signalling version is not served here".
		opensSession, known := liveKitSignalPaths[r.URL.Path]
		upgrade := isWebSocketUpgrade(r)
		if !known || r.Method != http.MethodGet || upgrade != opensSession {
			writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "access denied")
			return
		}

		// The proxy's only origin decision: proxyWebSocket's Accept skips its own check.
		if !isOriginAllowed(r, allowedOrigins) {
			slog.Warn("livekit proxy: origin rejected",
				"origin", r.Header.Get("Origin"), "path", r.URL.Path, "remote", r.RemoteAddr)
			writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "access denied")
			return
		}

		// LiveKit marks its validate answers readable from any origin, which the SDK needs to tell a
		// refusal from an unreachable server; the proxy's own answers on those paths do the same.
		if !opensSession {
			w.Header().Set(corsAllowOriginHeader, "*")
		}

		// The query is forwarded re-encoded from this parse, so LiveKit reads the same parameters the
		// checks below saw. The proxy carries one participant per join, so "publish" is not served.
		query := r.URL.Query()
		if query.Has("publish") {
			writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "access denied")
			return
		}
		ticket, ok := admitVoiceSession(w, r, gate, presentedVoiceCredential(r, query))
		if !ok {
			return
		}
		query.Del(liveKitAccessTokenParam)

		if upgrade {
			proxyWebSocket(w, r, &wsTarget, query.Encode(), ticket)
			return
		}

		out := r.Clone(r.Context())
		out.URL.RawQuery = query.Encode()
		out.Header.Set("Authorization", liveKitBearerPrefix+ticket.Token)
		out.Header.Del("Upgrade")             // this branch never switches protocols
		w.Header().Del(corsAllowOriginHeader) // LiveKit's answer carries its own
		httpProxy.ServeHTTP(w, out)
	})
}

// presentedVoiceCredential returns the credential a signalling request carries, read the way LiveKit
// reads it: the Authorization header when present (it must be a Bearer), otherwise the access_token
// query parameter. Empty means none.
func presentedVoiceCredential(r *http.Request, query url.Values) string {
	if authz := r.Header.Get("Authorization"); authz != "" {
		token, isBearer := strings.CutPrefix(authz, liveKitBearerPrefix)
		if !isBearer {
			return ""
		}
		return token
	}
	return query.Get(liveKitAccessTokenParam)
}

// admitVoiceSession asks gate for a ticket and answers the request itself when there is none: 401 for a
// credential that does not verify, 403 for one that names no current join, 503 when the check could not
// be made (the SDK retries anything that is not a 4xx).
func admitVoiceSession(w http.ResponseWriter, r *http.Request, gate VoiceSessionGate, presented string) (ws.VoiceSessionTicket, bool) {
	if presented == "" {
		writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "unauthorized")
		return ws.VoiceSessionTicket{}, false
	}
	if gate == nil {
		writeErr(w, http.StatusServiceUnavailable, httperr.CodeServiceUnavailable, "voice temporarily unavailable")
		return ws.VoiceSessionTicket{}, false
	}
	ticket, err := gate(r.Context(), presented)
	switch {
	case err == nil && ticket.Confirm != nil:
		return ticket, true
	case errors.Is(err, ws.ErrVoiceCredentialInvalid):
		writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "unauthorized")
	case errors.Is(err, ws.ErrVoiceSessionRefused):
		writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "access denied")
	default:
		slog.Warn("livekit proxy: voice session check failed", "path", r.URL.Path, "err", err)
		writeErr(w, http.StatusServiceUnavailable, httperr.CodeServiceUnavailable, "voice temporarily unavailable")
	}
	return ws.VoiceSessionTicket{}, false
}

// isWebSocketUpgrade reads Connection as the token list it is: browsers send "keep-alive, Upgrade".
func isWebSocketUpgrade(r *http.Request) bool {
	if !strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		return false
	}
	for _, v := range r.Header.Values("Connection") {
		for token := range strings.SplitSeq(v, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
				return true
			}
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

// proxyWebSocket connects one admitted signalling request. rawQuery is the client's query without its
// credential.
func proxyWebSocket(w http.ResponseWriter, r *http.Request, target *url.URL, rawQuery string, ticket ws.VoiceSessionTicket) {
	backendURL := *target
	backendURL.Path = r.URL.Path
	backendURL.RawQuery = rawQuery

	// The ticket's credential is the only header LiveKit sees; nothing of the client's is forwarded.
	backendHeader := http.Header{"Authorization": {liveKitBearerPrefix + ticket.Token}}

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
		// websocket.Dial wraps a *url.Error embedding the full request URL, and the admin ring buffer
		// captures DEBUG+. No credential travels in the URL any more; the query and the ticket's credential
		// are scrubbed all the same.
		safeErr := redactKey(err.Error(), backendURL.RawQuery)
		safeErr = redactKey(safeErr, ticket.Token)
		slog.Warn("livekit proxy: backend dial failed", "host", backendURL.Host, "path", backendURL.Path, "err", safeErr)
		writeErr(w, http.StatusBadGateway, httperr.CodeBadGateway, "backend unavailable")
		return
	}
	defer backConn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best-effort close on defer
	// The library default (32 KiB) would tear down both legs on a large signaling frame before copyWS's own
	// limit.
	backConn.SetReadLimit(wsProxyMaxMessageSize)

	// LiveKit starts the session before it answers the upgrade, so the session exists now and the client
	// cannot reach it yet. Confirm must not be cut short by the client hanging up: it may have a session
	// to remove.
	confirmCtx, cancelConfirm := context.WithTimeout(context.WithoutCancel(r.Context()), wsProxyConfirmTimeout)
	confirmErr := ticket.Confirm(confirmCtx)
	cancelConfirm()
	if confirmErr != nil {
		if errors.Is(confirmErr, ws.ErrVoiceSessionRefused) {
			writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "access denied")
			return
		}
		if errors.Is(confirmErr, ws.ErrVoiceSessionAbsent) && relayBackendLeave(w, r, backConn) {
			return
		}
		slog.Warn("livekit proxy: voice session confirm failed", "path", backendURL.Path, "err", confirmErr)
		writeErr(w, http.StatusServiceUnavailable, httperr.CodeServiceUnavailable, "voice temporarily unavailable")
		return
	}

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

// relayBackendLeave handles a resume LiveKit turned down: it then holds no participant and its first and
// only message tells the client to reconnect from scratch, which the SDK needs to see. That one message
// is passed on and the connection closed; it reports false, with nothing written, for anything else.
func relayBackendLeave(w http.ResponseWriter, r *http.Request, backConn *websocket.Conn) bool {
	ctx, cancel := context.WithTimeout(r.Context(), wsProxyLeaveWait)
	defer cancel()
	msgType, data, err := backConn.Read(ctx)
	if err != nil || msgType != websocket.MessageBinary {
		return false
	}
	var first livekit.SignalResponse
	if proto.Unmarshal(data, &first) != nil || first.GetLeave() == nil {
		return false
	}
	frontConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:       []string{backConn.Subprotocol()},
		InsecureSkipVerify: true, // the origin was decided by isOriginAllowed
	})
	if err != nil {
		slog.Warn("livekit proxy: frontend accept failed", "err", err)
		return true
	}
	defer frontConn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best-effort close on defer
	if err := frontConn.Write(ctx, msgType, data); err != nil {
		slog.Debug("livekit proxy: relaying the backend's leave failed", "err", err)
	}
	return true
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
