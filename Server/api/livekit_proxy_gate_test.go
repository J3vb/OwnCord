package api_test

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/ws"
)

// recordingGate is a VoiceSessionGate whose answers a test sets and whose calls
// it can read back.
type recordingGate struct {
	admitErr   error
	confirmErr error
	// onConfirm, when set, runs inside Confirm before it answers.
	onConfirm func()

	mu        sync.Mutex
	presented []string
	confirms  atomic.Int32
}

func (g *recordingGate) admit(_ context.Context, presented string) (ws.VoiceSessionTicket, error) {
	g.mu.Lock()
	g.presented = append(g.presented, presented)
	g.mu.Unlock()
	if g.admitErr != nil {
		return ws.VoiceSessionTicket{}, g.admitErr
	}
	return ws.VoiceSessionTicket{
		Token: api.IssuedCredentialForTest,
		Confirm: func(context.Context) error {
			g.confirms.Add(1)
			if g.onConfirm != nil {
				g.onConfirm()
			}
			return g.confirmErr
		},
	}, nil
}

func (g *recordingGate) presentedCredentials() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.presented...)
}

// countingWSBackend accepts WebSockets, counts them, and reports on closed when
// one ends.
func countingWSBackend(t *testing.T) (url string, dials *atomic.Int32, closed <-chan struct{}) {
	t.Helper()
	dials = &atomic.Int32{}
	done := make(chan struct{}, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dials.Add(1)
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer conn.CloseNow() //nolint:errcheck // best-effort
		for {
			typ, data, err := conn.Read(r.Context())
			if err != nil {
				done <- struct{}{}
				return
			}
			if err := conn.Write(r.Context(), typ, data); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return "ws://" + srv.Listener.Addr().String(), dials, done
}

// gatedProxy serves a proxy for backend behind gate and returns its address.
func gatedProxy(t *testing.T, backend string, gate *recordingGate) string {
	t.Helper()
	proxy := httptest.NewServer(api.NewLiveKitProxy(backend, []string{"*"}, gate.admit))
	t.Cleanup(proxy.Close)
	return proxy.Listener.Addr().String()
}

// plainBackend serves handler as the HTTP backend of a proxy.
func plainBackend(t *testing.T, handler http.HandlerFunc) string {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv.URL
}

// dialGated opens a WebSocket through the proxy at addr and fails the test
// when it is not accepted.
func dialGated(t *testing.T, addr, pathAndQuery string) (context.Context, *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	t.Cleanup(cancel)
	conn, resp, err := websocket.Dial(ctx, "ws://"+addr+pathAndQuery, nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("dial through proxy: %v", err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return ctx, conn
}

// upgradeThroughProxy attempts one signalling upgrade and returns the status
// the proxy answered with (101 on success).
func upgradeThroughProxy(t *testing.T, proxyAddr, pathAndQuery string, header http.Header) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, "ws://"+proxyAddr+pathAndQuery, &websocket.DialOptions{HTTPHeader: header})
	if resp != nil && resp.Body != nil {
		defer resp.Body.Close() //nolint:errcheck // best-effort close in test
	}
	if err == nil {
		_ = conn.CloseNow()
	}
	if resp == nil {
		t.Fatalf("no HTTP response for %s: %v", pathAndQuery, err)
	}
	return resp.StatusCode
}

// getThroughProxy sends one plain GET and returns the proxy's status.
func getThroughProxy(t *testing.T, proxyAddr, pathAndQuery string, header http.Header) int {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+proxyAddr+pathAndQuery, nil)
	if err != nil {
		t.Fatal(err)
	}
	maps.Copy(req.Header, header)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", pathAndQuery, err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

// A request the gate does not admit is answered by the proxy itself and never
// reaches LiveKit: no credential or a malformed one is a 401, a refused join a
// 403, and a check that could not be made a 503 the SDK retries.
func TestLiveKitProxy_UnadmittedRequestNeverReachesBackend(t *testing.T) {
	for _, tc := range []struct {
		name      string
		query     string
		header    http.Header
		admitErr  error
		want      int
		wantAsked bool
	}{
		{name: "no credential", want: http.StatusUnauthorized},
		{name: "authorization is not a bearer", query: "?access_token=client", header: http.Header{"Authorization": {"Basic abc"}}, want: http.StatusUnauthorized},
		{name: "credential does not verify", query: "?access_token=client", admitErr: fmt.Errorf("%w: test", ws.ErrVoiceCredentialInvalid), want: http.StatusUnauthorized, wantAsked: true},
		{name: "no current join", query: "?access_token=client", admitErr: fmt.Errorf("%w: test", ws.ErrVoiceSessionRefused), want: http.StatusForbidden, wantAsked: true},
		{name: "check unavailable", query: "?access_token=client", admitErr: errors.New("database is locked"), want: http.StatusServiceUnavailable, wantAsked: true},
		{name: "publish parameter", query: "?access_token=client&publish=cam", want: http.StatusForbidden},
		{name: "empty publish parameter", query: "?publish=&access_token=client", want: http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backend, hits, _ := countingWSBackend(t)
			gate := &recordingGate{admitErr: tc.admitErr}
			addr := gatedProxy(t, backend, gate)

			for _, path := range []string{"/rtc", "/rtc/v1"} {
				if got := upgradeThroughProxy(t, addr, path+tc.query, tc.header); got != tc.want {
					t.Errorf("upgrade %s: status %d, want %d", path, got, tc.want)
				}
			}
			for _, path := range []string{"/rtc/validate", "/rtc/v1/validate"} {
				if got := getThroughProxy(t, addr, path+tc.query, tc.header); got != tc.want {
					t.Errorf("GET %s: status %d, want %d", path, got, tc.want)
				}
			}
			if n := hits.Load(); n != 0 {
				t.Errorf("backend was reached %d times, want 0", n)
			}
			wantAsked := 0
			if tc.wantAsked {
				wantAsked = 4
			}
			if asked := len(gate.presentedCredentials()); asked != wantAsked {
				t.Errorf("gate was asked %d times, want %d", asked, wantAsked)
			}
		})
	}
}

// A proxy built without a gate admits nothing.
func TestLiveKitProxy_NoGateFailsClosed(t *testing.T) {
	backend, dials, _ := countingWSBackend(t)
	proxy := httptest.NewServer(api.NewLiveKitProxy(backend, []string{"*"}, nil))
	t.Cleanup(proxy.Close)
	if got := upgradeThroughProxy(t, proxy.Listener.Addr().String(), "/rtc?access_token=client", nil); got != http.StatusServiceUnavailable {
		t.Errorf("status %d, want 503", got)
	}
	if n := dials.Load(); n != 0 {
		t.Errorf("backend was dialed %d times, want 0", n)
	}
}

// Confirm runs after LiveKit has the session and before the client is
// connected. When it refuses, or cannot decide, the client is never upgraded
// and the backend connection is closed.
func TestLiveKitProxy_WebSocket_ConfirmRefusalNeverUpgradesClient(t *testing.T) {
	for _, tc := range []struct {
		name       string
		confirmErr error
		want       int
	}{
		{"join ended while connecting", fmt.Errorf("%w: test", ws.ErrVoiceSessionRefused), http.StatusForbidden},
		{"check unavailable", errors.New("database is locked"), http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backend, dials, closed := countingWSBackend(t)
			var dialsAtConfirm int32
			gate := &recordingGate{confirmErr: tc.confirmErr}
			gate.onConfirm = func() { dialsAtConfirm = dials.Load() }
			addr := gatedProxy(t, backend, gate)

			if got := upgradeThroughProxy(t, addr, "/rtc?access_token=client", nil); got != tc.want {
				t.Errorf("status %d, want %d", got, tc.want)
			}
			if dialsAtConfirm != 1 || gate.confirms.Load() != 1 {
				t.Errorf("Confirm ran %d times with %d backend dials before it, want once after one dial", gate.confirms.Load(), dialsAtConfirm)
			}
			select {
			case <-closed:
			case <-time.After(5 * time.Second):
				t.Fatal("the backend connection was left open after Confirm failed")
			}
		})
	}
}

// Confirm is not cut short by the client going away: it may have a session to
// remove at LiveKit. The client here hangs up at the moment Confirm starts.
func TestLiveKitProxy_WebSocket_ConfirmOutlivesClientHangup(t *testing.T) {
	backend, _, _ := countingWSBackend(t)
	clientCtx, clientHangsUp := context.WithCancel(t.Context())
	defer clientHangsUp()
	confirmed := make(chan error, 1)
	proxy := api.NewLiveKitProxy(backend, []string{"*"}, func(context.Context, string) (ws.VoiceSessionTicket, error) {
		return ws.VoiceSessionTicket{
			Token: api.IssuedCredentialForTest,
			Confirm: func(confirmCtx context.Context) error {
				clientHangsUp()
				_, bounded := confirmCtx.Deadline()
				if !bounded {
					confirmed <- errors.New("Confirm ran without a deadline")
					return nil
				}
				confirmed <- confirmCtx.Err()
				return confirmCtx.Err()
			},
		}, nil
	})

	r := httptest.NewRequest("GET", "/rtc?access_token=client", nil).WithContext(clientCtx)
	r.Header.Set("Connection", "Upgrade")
	r.Header.Set("Upgrade", "websocket")
	proxy.ServeHTTP(httptest.NewRecorder(), r)

	select {
	case err := <-confirmed:
		if err != nil {
			t.Fatalf("Confirm's context after the client hung up: %v", err)
		}
	default:
		t.Fatal("Confirm did not run")
	}
}

// An admitted request is confirmed once and then carries frames both ways.
func TestLiveKitProxy_WebSocket_AdmittedSessionIsConfirmedOnce(t *testing.T) {
	backend, dials, _ := countingWSBackend(t)
	gate := &recordingGate{}
	ctx, conn := dialGated(t, gatedProxy(t, backend, gate), "/rtc/v1?access_token=client")
	if err := conn.Write(ctx, websocket.MessageText, []byte("signal")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, got, err := conn.Read(ctx); err != nil || string(got) != "signal" {
		t.Fatalf("echo = %q, %v", got, err)
	}
	if gate.confirms.Load() != 1 || dials.Load() != 1 {
		t.Errorf("Confirm ran %d times over %d backend dials, want 1 and 1", gate.confirms.Load(), dials.Load())
	}
}

// firstMessageBackend accepts WebSockets and sends each one message, then
// closes, as LiveKit does for a resume it turns down.
func firstMessageBackend(t *testing.T, first *livekit.SignalResponse) string {
	t.Helper()
	payload, err := proto.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		_ = conn.Write(r.Context(), websocket.MessageBinary, payload)
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}))
	t.Cleanup(srv.Close)
	return "ws://" + srv.Listener.Addr().String()
}

// When LiveKit holds no participant for a resume, its one message telling the
// client to reconnect from scratch is passed on and nothing else is: the SDK
// acts on that message, and would keep retrying the resume on an error status.
func TestLiveKitProxy_WebSocket_AbsentSessionRelaysOnlyTheBackendLeave(t *testing.T) {
	absent := fmt.Errorf("%w: test", ws.ErrVoiceSessionAbsent)
	leave := &livekit.SignalResponse{Message: &livekit.SignalResponse_Leave{Leave: &livekit.LeaveRequest{
		Reason: livekit.DisconnectReason_STATE_MISMATCH, Action: livekit.LeaveRequest_RECONNECT,
	}}}

	t.Run("leave is relayed and the connection closed", func(t *testing.T) {
		gate := &recordingGate{confirmErr: absent}
		ctx, conn := dialGated(t, gatedProxy(t, firstMessageBackend(t, leave), gate), "/rtc?access_token=client&reconnect=1")
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var got livekit.SignalResponse
		if err := proto.Unmarshal(data, &got); err != nil || got.GetLeave().GetAction() != livekit.LeaveRequest_RECONNECT {
			t.Fatalf("client received %v (%v), want the backend's leave", &got, err)
		}
		if _, _, err := conn.Read(ctx); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
			t.Fatalf("after the leave: %v, want a normal close", err)
		}
	})

	t.Run("any other first message is not a session", func(t *testing.T) {
		join := &livekit.SignalResponse{Message: &livekit.SignalResponse_Join{Join: &livekit.JoinResponse{}}}
		gate := &recordingGate{confirmErr: absent}
		addr := gatedProxy(t, firstMessageBackend(t, join), gate)
		if got := upgradeThroughProxy(t, addr, "/rtc?access_token=client", nil); got != http.StatusServiceUnavailable {
			t.Errorf("status %d, want 503", got)
		}
	})
}

// rawUpgradeStatus writes one upgrade request by hand, with the Connection and
// Upgrade headers exactly as given, and returns the status answered.
func rawUpgradeStatus(t *testing.T, addr, pathAndQuery, connection, upgrade string) int {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer conn.Close() //nolint:errcheck // best-effort close in test
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	_, err = fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\nConnection: %s\r\nUpgrade: %s\r\n"+
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
		pathAndQuery, addr, connection, upgrade)
	if err != nil {
		t.Fatalf("write request: %v", err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

// However a client spells its upgrade headers, a session either goes through
// Confirm or is not opened; browsers differ here ("keep-alive, Upgrade").
func TestLiveKitProxy_WebSocket_EveryUpgradeSpellingIsConfirmedOrRefused(t *testing.T) {
	for _, tc := range []struct {
		name, path, connection, upgrade string
		want                            int
	}{
		{"single token", "/rtc", "Upgrade", "websocket", http.StatusSwitchingProtocols},
		{"token list", "/rtc", "keep-alive, Upgrade", "websocket", http.StatusSwitchingProtocols},
		{"token list, other order and case", "/rtc/v1", "upgrade,Keep-Alive", "WebSocket", http.StatusSwitchingProtocols},
		{"another protocol", "/rtc", "keep-alive, Upgrade", "h2c", http.StatusForbidden},
		{"no upgrade token", "/rtc", "keep-alive", "websocket", http.StatusForbidden},
		{"validate path", "/rtc/validate", "keep-alive, Upgrade", "websocket", http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backend, dials, _ := countingWSBackend(t)
			gate := &recordingGate{}
			addr := gatedProxy(t, backend, gate)

			got := rawUpgradeStatus(t, addr, tc.path+"?access_token=client", tc.connection, tc.upgrade)
			if got != tc.want {
				t.Fatalf("status %d, want %d", got, tc.want)
			}
			wantSessions := int32(0)
			if tc.want == http.StatusSwitchingProtocols {
				wantSessions = 1
			}
			if dials.Load() != wantSessions || gate.confirms.Load() != wantSessions {
				t.Errorf("backend dialled %d times and Confirm ran %d times, want %d and %d",
					dials.Load(), gate.confirms.Load(), wantSessions, wantSessions)
			}
		})
	}
}

// A validate request is forwarded as a plain request whatever upgrade headers
// it carries.
func TestLiveKitProxy_ValidateNeverForwardsAnUpgrade(t *testing.T) {
	var gotUpgrade string
	addr := gatedProxy(t, plainBackend(t, func(w http.ResponseWriter, r *http.Request) {
		gotUpgrade = r.Header.Get("Upgrade")
		w.WriteHeader(http.StatusOK)
	}), &recordingGate{})

	got := rawUpgradeStatus(t, addr, "/rtc/validate?access_token=client", "keep-alive, Upgrade", "h2c")
	if got != http.StatusOK || gotUpgrade != "" {
		t.Errorf("status %d with Upgrade %q at the backend, want 200 and none", got, gotUpgrade)
	}
}

// The SDK's validate request is cross-origin, so it can read the status only
// from an answer marked readable. LiveKit marks its own; an answer the proxy
// gives in its place carries the mark once, and a forwarded one is not doubled.
func TestLiveKitProxy_ValidateAnswersAreReadableCrossOrigin(t *testing.T) {
	gate := &recordingGate{}
	addr := gatedProxy(t, plainBackend(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)
	}), gate)

	for _, tc := range []struct {
		name     string
		admitErr error
		want     int
	}{
		{"forwarded", nil, http.StatusOK},
		{"refused", fmt.Errorf("%w: test", ws.ErrVoiceSessionRefused), http.StatusForbidden},
		{"check unavailable", errors.New("database is locked"), http.StatusServiceUnavailable},
	} {
		gate.admitErr = tc.admitErr
		resp, err := http.Get("http://" + addr + "/rtc/validate?access_token=client")
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		_ = resp.Body.Close()
		if got := resp.Header.Values("Access-Control-Allow-Origin"); resp.StatusCode != tc.want || len(got) != 1 || got[0] != "*" {
			t.Errorf("%s: status %d with Access-Control-Allow-Origin %q, want %d with exactly one \"*\"", tc.name, resp.StatusCode, got, tc.want)
		}
	}
}

// The validate paths open no session, so they are admitted but not confirmed.
func TestLiveKitProxy_ValidateIsAdmittedNotConfirmed(t *testing.T) {
	var gotAuthz string
	gate := &recordingGate{}
	addr := gatedProxy(t, plainBackend(t, func(w http.ResponseWriter, r *http.Request) {
		gotAuthz = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}), gate)

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+addr+"/rtc/v1/validate", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer presented")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", resp.StatusCode)
	}
	if got := gate.presentedCredentials(); len(got) != 1 || got[0] != "presented" {
		t.Errorf("gate was asked about %q, want only %q", got, "presented")
	}
	if want := "Bearer " + api.IssuedCredentialForTest; gotAuthz != want {
		t.Errorf("backend saw Authorization %q, want %q", gotAuthz, want)
	}
	if n := gate.confirms.Load(); n != 0 {
		t.Errorf("Confirm ran %d times for a validate request, want 0", n)
	}
}
