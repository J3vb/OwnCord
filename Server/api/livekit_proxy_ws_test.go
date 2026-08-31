package api_test

import (
	"bytes"
	"context"
	"encoding/json"
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

func TestLiveKitProxy_WebSocket_RoundTrip(t *testing.T) {
	backend := echoWSBackend(t)

	proxy := httptest.NewServer(api.NewLiveKitProxy(backend, []string{"*"}))
	t.Cleanup(proxy.Close)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	conn, dialResp, err := websocket.Dial(ctx, "ws://"+proxy.Listener.Addr().String()+"/rtc", nil)
	if dialResp != nil && dialResp.Body != nil {
		defer dialResp.Body.Close() //nolint:errcheck // best-effort close in test
	}
	if err != nil {
		t.Fatalf("dial through proxy: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best-effort

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
	proxy := httptest.NewServer(api.NewLiveKitProxy(backend, []string{"*"}))
	t.Cleanup(proxy.Close)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	conn, dialResp, err := websocket.Dial(ctx, "ws://"+proxy.Listener.Addr().String()+"/rtc", nil)
	if dialResp != nil && dialResp.Body != nil {
		defer dialResp.Body.Close() //nolint:errcheck // best-effort close in test
	}
	if err != nil {
		t.Fatalf("dial through proxy: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best-effort

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

func TestLiveKitProxy_WebSocket_PreservesQueryString(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		_ = conn.Write(r.Context(), websocket.MessageText, []byte("ok"))
		conn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best-effort
	}))
	t.Cleanup(srv.Close)

	proxy := httptest.NewServer(api.NewLiveKitProxy("ws://"+srv.Listener.Addr().String(), []string{"*"}))
	t.Cleanup(proxy.Close)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	conn, dialResp, err := websocket.Dial(ctx, "ws://"+proxy.Listener.Addr().String()+"/rtc?access_token=abc", nil)
	if dialResp != nil && dialResp.Body != nil {
		defer dialResp.Body.Close() //nolint:errcheck // best-effort close in test
	}
	if err != nil {
		t.Fatalf("dial through proxy: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best-effort

	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatalf("read: %v", err)
	}
	// LiveKit carries the join token in the query string; dropping it would
	// turn every voice join into an auth failure.
	if gotQuery != "access_token=abc" {
		t.Errorf("backend saw query %q, want %q", gotQuery, "access_token=abc")
	}
}

func TestLiveKitProxy_WebSocket_BackendUnavailable(t *testing.T) {
	// Nothing is listening on this port, so the backend dial must fail.
	proxy := httptest.NewServer(api.NewLiveKitProxy("ws://127.0.0.1:1", []string{"*"}))
	t.Cleanup(proxy.Close)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	_, resp, err := websocket.Dial(ctx, "ws://"+proxy.Listener.Addr().String()+"/rtc", nil)
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
	proxy := httptest.NewServer(api.NewLiveKitProxy(backend, []string{"*"}))
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
	proxy := httptest.NewServer(api.NewLiveKitProxy(backend, []string{"https://allowed.example"}))
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
	hub, err := ws.NewHub(ws.HubOptions{DB: database, Limiter: auth.NewRateLimiter(), LiveKit: lk, Settings: service.NewSettingsService(database), Readers: ws.DBReaders(database)})
	if err != nil {
		t.Fatalf("ws.NewHub: %v", err)
	}
	return hub
}

func TestHandleLiveKitHealth_Healthy(t *testing.T) {
	handler := api.LiveKitHealthHandlerForTest(hubWithLiveKit(t, http.StatusOK))

	rr := httptest.NewRecorder()
	handler(rr, httptest.NewRequest(http.MethodGet, "/api/v1/livekit/health", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
	}
	var body struct {
		Status           string `json:"status"`
		LiveKitReachable bool   `json:"livekit_reachable"`
		Error            string `json:"error"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
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

	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (body %q)", rr.Code, rr.Body.String())
	}
	var body struct {
		Status           string `json:"status"`
		LiveKitReachable bool   `json:"livekit_reachable"`
		Error            string `json:"error"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
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

	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "not configured") {
		t.Errorf("body = %q, want it to name the missing configuration", rr.Body.String())
	}
}
