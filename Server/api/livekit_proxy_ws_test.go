package api_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// proxyWebSocket and copyWS carry every LiveKit signaling frame between the
// client and the media server, and neither had any coverage — the existing
// livekit_proxy_test.go stops at the path allowlist and Origin check, before
// the upgrade. handleLiveKitHealth was in the same position: its only "test"
// hook re-implemented the handler rather than calling it.

// echoWSBackend starts a WebSocket server that echoes every message it
// receives, and returns its ws:// URL.
func echoWSBackend(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true,
		})
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best-effort
		conn.SetReadLimit(1 << 20)                          // let large-frame tests reach the proxy's own limit

		for {
			typ, data, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			if err := conn.Write(r.Context(), typ, data); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return "ws://" + srv.Listener.Addr().String()
}

// dialLiveKitProxy starts a LiveKit proxy in front of backend and dials path
// through it, returning the connection and the context that bounds it.
func dialLiveKitProxy(t *testing.T, backend, path string, opts *websocket.DialOptions) (context.Context, *websocket.Conn) {
	t.Helper()
	proxy := httptest.NewServer(api.NewLiveKitProxy(backend, []string{"*"}, api.AdmitAllVoiceSessionsForTest))
	t.Cleanup(proxy.Close)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	t.Cleanup(cancel)

	conn, dialResp, err := websocket.Dial(ctx, "ws://"+proxy.Listener.Addr().String()+path, opts)
	if dialResp != nil && dialResp.Body != nil {
		t.Cleanup(func() { _ = dialResp.Body.Close() })
	}
	if err != nil {
		t.Fatalf("dial through proxy: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	return ctx, conn
}

func TestLiveKitProxy_WebSocket_RoundTrip(t *testing.T) {
	backend := echoWSBackend(t)

	ctx, conn := dialLiveKitProxy(t, backend, "/rtc?access_token=client", nil)

	// Frontend → backend → frontend, through both copyWS goroutines.
	if err := conn.Write(ctx, websocket.MessageText, []byte("signal")); err != nil {
		t.Fatalf("write: %v", err)
	}
	typ, got, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != websocket.MessageText || string(got) != "signal" {
		t.Errorf("echo = (%v, %q), want (text, \"signal\")", typ, got)
	}
}

func TestLiveKitProxy_WebSocket_ForwardsBinary(t *testing.T) {
	backend := echoWSBackend(t)
	ctx, conn := dialLiveKitProxy(t, backend, "/rtc?access_token=client", nil)

	// LiveKit signaling is protobuf, so the binary opcode must survive the hop.
	payload := []byte{0x00, 0x01, 0x02, 0xff}
	if err := conn.Write(ctx, websocket.MessageBinary, payload); err != nil {
		t.Fatalf("write: %v", err)
	}
	typ, got, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != websocket.MessageBinary || !bytes.Equal(got, payload) {
		t.Errorf("echo = (%v, %v), want (binary, %v)", typ, got, payload)
	}
}

// The client's query reaches LiveKit without its credential: every access_token
// is dropped (a native client's loopback proxy can add a second one) and the
// rest is kept, so LiveKit has exactly one credential to read, the header.
func TestLiveKitProxy_WebSocket_ForwardsQueryWithoutClientCredential(t *testing.T) {
	var gotQuery, gotAuthz string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		gotAuthz = r.Header.Get("Authorization")
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		_ = conn.Write(r.Context(), websocket.MessageText, []byte("ok"))
		conn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best-effort
	}))
	t.Cleanup(srv.Close)

	ctx, conn := dialLiveKitProxy(t, "ws://"+srv.Listener.Addr().String(),
		"/rtc?access_token=abc&sdk=js&access_token=second&auto_subscribe=1", nil)

	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatalf("read: %v", err)
	}
	if gotQuery != "auto_subscribe=1&sdk=js" {
		t.Errorf("backend saw query %q, want %q", gotQuery, "auto_subscribe=1&sdk=js")
	}
	if want := "Bearer " + api.IssuedCredentialForTest; gotAuthz != want {
		t.Errorf("backend saw Authorization %q, want %q", gotAuthz, want)
	}
}

// TestLiveKitProxy_WebSocket_HeaderCredential covers the Linux client's native
// voice: the LiveKit Rust SDK sends its room-join token as an Authorization
// header, not the access_token query parameter. The gate is asked about that
// token, LiveKit gets the issued one, and no other client header is forwarded.
func TestLiveKitProxy_WebSocket_HeaderCredential(t *testing.T) {
	const presented = "eyJhbGciOiJIUzI1NiJ9.native.sig"
	var gotAuthz, gotCookie string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuthz = r.Header.Get("Authorization")
		gotCookie = r.Header.Get("Cookie")
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		_ = conn.Write(r.Context(), websocket.MessageText, []byte("ok"))
		conn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best-effort
	}))
	t.Cleanup(srv.Close)

	gate := &recordingGate{}
	proxy := httptest.NewServer(api.NewLiveKitProxy("ws://"+srv.Listener.Addr().String(), []string{"*"}, gate.admit))
	t.Cleanup(proxy.Close)
	// The header wins over a query credential, as it does at LiveKit.
	conn, resp, err := websocket.Dial(t.Context(), "ws://"+proxy.Listener.Addr().String()+"/rtc?access_token=from-query", &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + presented}, "Cookie": {"session=secret"}},
	})
	if resp != nil && resp.Body != nil {
		defer resp.Body.Close() //nolint:errcheck // best-effort close in test
	}
	if err != nil {
		t.Fatalf("dial through proxy: %v", err)
	}
	defer conn.CloseNow() //nolint:errcheck // best-effort close in test

	if _, _, err := conn.Read(t.Context()); err != nil {
		t.Fatalf("read: %v", err)
	}
	if got := gate.presentedCredentials(); len(got) != 1 || got[0] != presented {
		t.Errorf("gate was asked about %q, want only %q", got, presented)
	}
	if want := "Bearer " + api.IssuedCredentialForTest; gotAuthz != want {
		t.Errorf("backend saw Authorization %q, want %q", gotAuthz, want)
	}
	if gotCookie != "" {
		t.Errorf("backend saw Cookie %q; only the issued credential may be forwarded", gotCookie)
	}
}

func TestLiveKitProxy_WebSocket_BackendUnavailable(t *testing.T) {
	// Nothing is listening on this port, so the backend dial must fail.
	proxy := httptest.NewServer(api.NewLiveKitProxy("ws://127.0.0.1:1", []string{"*"}, api.AdmitAllVoiceSessionsForTest))
	t.Cleanup(proxy.Close)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	_, resp, err := websocket.Dial(ctx, "ws://"+proxy.Listener.Addr().String()+"/rtc?access_token=client", nil)
	if err == nil {
		t.Fatal("dial succeeded despite an unreachable backend")
	}
	if resp == nil {
		t.Fatal("no HTTP response returned for the failed upgrade")
	}
	defer resp.Body.Close() //nolint:errcheck // best-effort
	if resp.StatusCode != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", resp.StatusCode)
	}
}

func TestLiveKitProxy_WebSocket_BlockedPathNotUpgraded(t *testing.T) {
	backend := echoWSBackend(t)
	proxy := httptest.NewServer(api.NewLiveKitProxy(backend, []string{"*"}, api.AdmitAllVoiceSessionsForTest))
	t.Cleanup(proxy.Close)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	// The allowlist runs before the upgrade branch, so an Upgrade header must
	// not be a way around it.
	_, resp, err := websocket.Dial(ctx, "ws://"+proxy.Listener.Addr().String()+"/twirp/whatever", nil)
	if err == nil {
		t.Fatal("upgrade to a blocked path succeeded")
	}
	if resp == nil {
		t.Fatal("no HTTP response returned")
	}
	defer resp.Body.Close() //nolint:errcheck // best-effort
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", resp.StatusCode)
	}
}

func TestLiveKitProxy_WebSocket_CrossOriginRejected(t *testing.T) {
	backend := echoWSBackend(t)
	proxy := httptest.NewServer(api.NewLiveKitProxy(backend, []string{"https://allowed.example"}, api.AdmitAllVoiceSessionsForTest))
	t.Cleanup(proxy.Close)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	_, resp, err := websocket.Dial(ctx, "ws://"+proxy.Listener.Addr().String()+"/rtc", &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"https://evil.example"}},
	})
	if err == nil {
		t.Fatal("upgrade from a disallowed origin succeeded")
	}
	if resp == nil {
		t.Fatal("no HTTP response returned")
	}
	defer resp.Body.Close() //nolint:errcheck // best-effort
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", resp.StatusCode)
	}
}

// A reverse proxy (nginx's $host) forwards Host without the default port while
// the client's Origin keeps it. isOriginAllowed treats the two as the same
// origin, so the upgrade must succeed rather than pass the pre-check and then
// be refused by websocket.Accept's own literal host comparison.
func TestLiveKitProxy_WebSocket_DefaultPortOriginBehindProxy(t *testing.T) {
	backend := echoWSBackend(t)
	proxy := httptest.NewServer(api.NewLiveKitProxy(backend, nil, api.AdmitAllVoiceSessionsForTest))
	t.Cleanup(proxy.Close)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	conn, resp, err := websocket.Dial(ctx, "ws://"+proxy.Listener.Addr().String()+"/rtc/v1?access_token=client", &websocket.DialOptions{
		Host:       "owncord.example",
		HTTPHeader: http.Header{"Origin": []string{"https://owncord.example:443"}},
	})
	if resp != nil && resp.Body != nil {
		defer resp.Body.Close() //nolint:errcheck // best-effort close in test
	}
	if err != nil {
		t.Fatalf("upgrade with a default-port Origin was refused: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best-effort

	if err := conn.Write(ctx, websocket.MessageText, []byte("signal")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, got, err := conn.Read(ctx); err != nil || string(got) != "signal" {
		t.Fatalf("read = %q, %v; want echoed signal", got, err)
	}
}

// ─── handleLiveKitHealth (the real handler) ─────────────────────────────────

// hubWithLiveKit returns a Hub whose LiveKit client points at a stub room
// service replying with the supplied status.
func hubWithLiveKit(t *testing.T, status int) *ws.Hub {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if status != http.StatusOK {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"code":"internal","msg":"boom"}`))
			return
		}
		body, _ := proto.Marshal(&livekit.ListRoomsResponse{})
		w.Header().Set("Content-Type", "application/protobuf")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)

	lk, err := ws.NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "testkeytestkeytest",
		LiveKitAPISecret: "testsecrettestsecrettestsecret",
		LiveKitURL:       "ws://" + srv.Listener.Addr().String(),
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	hub := newBareHub(t, lk)
	return hub
}

// newBareHub builds the smallest hub NewHub now accepts: B3-4 made DB and
// Limiter required, so the pre-B3-4 ws.NewHub(nil, nil, nil) fixture — the
// poster child of construction succeeding with nothing wired — is illegal by
// design. An unmigrated in-memory database is enough: construction only
// best-effort-reads the settings cache.
func newBareHub(t *testing.T, lk *ws.LiveKitClient) *ws.Hub {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	hub, err := ws.NewHub(ws.HubOptions{DB: database, Limiter: auth.NewRateLimiter(), LiveKit: lk, Settings: service.NewSettingsService(database), Readers: ws.DBReaders(database), Voice: service.NewVoiceService(database), Presence: service.NewUserService(database), Auth: service.NewSessionService(database)})
	if err != nil {
		t.Fatalf("ws.NewHub: %v", err)
	}
	return hub
}

func TestHandleLiveKitHealth_Healthy(t *testing.T) {
	handler := api.LiveKitHealthHandlerForTest(hubWithLiveKit(t, http.StatusOK))

	rr := httptest.NewRecorder()
	handler(rr, httptest.NewRequest(http.MethodGet, "/api/v1/livekit/health", nil))

	requireStatus(t, rr, http.StatusOK)
	body := decodeBody[struct {
		Status           string `json:"status"`
		LiveKitReachable bool   `json:"livekit_reachable"`
		Error            string `json:"error"`
	}](t, rr)
	if body.Status != "ok" || !body.LiveKitReachable {
		t.Errorf("body = %+v, want status ok and reachable", body)
	}
	if body.Error != "" {
		t.Errorf("error = %q on the healthy path, want it omitted", body.Error)
	}
}

func TestHandleLiveKitHealth_Degraded(t *testing.T) {
	handler := api.LiveKitHealthHandlerForTest(hubWithLiveKit(t, http.StatusInternalServerError))

	rr := httptest.NewRecorder()
	handler(rr, httptest.NewRequest(http.MethodGet, "/api/v1/livekit/health", nil))

	requireStatus(t, rr, http.StatusServiceUnavailable)
	body := decodeBody[struct {
		Status           string `json:"status"`
		LiveKitReachable bool   `json:"livekit_reachable"`
		Error            string `json:"error"`
	}](t, rr)
	if body.Status != "degraded" || body.LiveKitReachable {
		t.Errorf("body = %+v, want status degraded and unreachable", body)
	}
	if body.Error == "" {
		t.Error("error is empty on the degraded path; the reason should be surfaced")
	}
}

func TestHandleLiveKitHealth_NotConfigured(t *testing.T) {
	// A hub with no LiveKit client at all — the common case when voice is off.
	handler := api.LiveKitHealthHandlerForTest(newBareHub(t, nil))

	rr := httptest.NewRecorder()
	handler(rr, httptest.NewRequest(http.MethodGet, "/api/v1/livekit/health", nil))

	requireStatus(t, rr, http.StatusServiceUnavailable)
	if !strings.Contains(rr.Body.String(), "not configured") {
		t.Errorf("body = %q, want it to name the missing configuration", rr.Body.String())
	}
}

// The proxy documents a 256 KiB signaling limit, but the websocket library's
// own 32 KiB default read limit used to close both legs first.
func TestLiveKitProxy_WebSocket_LargeFrameLimit(t *testing.T) {
	const kib = 1024
	cases := []struct {
		name    string
		size    int
		wantErr bool
	}{
		{"above library default passes", 100 * kib, false},
		{"at proxy limit passes", 256 * kib, false},
		{"above proxy limit rejected", 256*kib + 1, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			backend := echoWSBackend(t)
			ctx, conn := dialLiveKitProxy(t, backend, "/rtc?access_token=client", nil)
			conn.SetReadLimit(512 * kib)

			payload := bytes.Repeat([]byte{0xab}, tc.size)
			if err := conn.Write(ctx, websocket.MessageBinary, payload); err != nil {
				t.Fatalf("write: %v", err)
			}
			_, got, err := conn.Read(ctx)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("read succeeded with %d bytes, want the connection closed", len(got))
				}
				if status := websocket.CloseStatus(err); status != websocket.StatusMessageTooBig {
					t.Fatalf("close status = %v, want %v (err: %v)", status, websocket.StatusMessageTooBig, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			if !bytes.Equal(got, payload) {
				t.Errorf("echoed %d bytes, want %d identical", len(got), len(payload))
			}
		})
	}
}
