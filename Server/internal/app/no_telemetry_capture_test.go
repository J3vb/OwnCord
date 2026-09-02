package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// dialRecorder records every connection the process's default HTTP
// transport opens and every name it resolves, without changing what
// happens. It is what the no-automatic-telemetry capture reads.
type dialRecorder struct {
	mu      sync.Mutex
	dials   []string // network+address of every DialContext
	lookups int      // resolver connections (any name resolution at all)
}

func (r *dialRecorder) install(t *testing.T) {
	t.Helper()
	transport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		t.Fatal("http.DefaultTransport is not an *http.Transport")
	}
	prevDial := transport.DialContext
	prevResolver := net.DefaultResolver
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		r.mu.Lock()
		r.dials = append(r.dials, network+" "+addr)
		r.mu.Unlock()
		if prevDial != nil {
			return prevDial(ctx, network, addr)
		}
		return dialer.DialContext(ctx, network, addr)
	}
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			r.mu.Lock()
			r.lookups++
			r.mu.Unlock()
			return dialer.DialContext(ctx, network, addr)
		},
	}
	t.Cleanup(func() {
		transport.DialContext = prevDial
		net.DefaultResolver = prevResolver
	})
}

func (r *dialRecorder) snapshot() (dials []string, lookups int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.dials...), r.lookups
}

// isLoopbackDial reports whether a recorded "network host:port" targets this
// machine.
func isLoopbackDial(rec string) bool {
	_, addr, ok := strings.Cut(rec, " ")
	if !ok {
		return false
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// TestNoAutomaticTelemetry_Capture is B4-8's runtime proof of BPR-055: the
// server as main() boots it, with the compiled defaults (TLS off, no LiveKit
// auto-download, no telemetry, no GIF key, no plugin allowlist), opens no
// connection beyond loopback and resolves no name while it is set up,
// registers and signs in a user, serves a WebSocket session with the ready
// payload and a channel read, accepts an upload, idles, and shuts down.
// The recorder hooks Go's default transport and resolver — the static
// egress-sites invariant (Server/invariants) covers clients built on their
// own transport by listing every such construct.
func TestNoAutomaticTelemetry_Capture(t *testing.T) {
	rec := &dialRecorder{}
	rec.install(t)

	port := freePort(t)
	a := bootTestApp(t, strconv.Itoa(port), "")
	ctx, cancel := context.WithCancel(context.Background())
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()
	// stopServer cancels the run and waits for it exactly once, whether the
	// body reaches its shutdown step or fails before it.
	var stopOnce sync.Once
	stopServer := func() (err error) {
		stopOnce.Do(func() {
			cancel()
			select {
			case err = <-runErr:
			case <-time.After(30 * time.Second):
				err = fmt.Errorf("Run did not return after cancel")
			}
		})
		return err
	}
	t.Cleanup(func() {
		if err := stopServer(); err != nil {
			t.Error(err)
		}
	})

	base := "http://127.0.0.1:" + strconv.Itoa(port)
	// The test's own traffic goes through a transport the recorder does not
	// see, so every recorded dial is the server's.
	client := &http.Client{Transport: &http.Transport{}, Timeout: 10 * time.Second}
	waitHealthy(t, client, base+"/health")

	// First-run setup: the owner account and the first invite.
	var setup struct {
		Token      string `json:"token"`
		InviteCode string `json:"invite_code"`
	}
	postJSONInto(t, client, base+"/admin/api/setup", "", map[string]any{
		"username": "owner", "password": "OwnerPass1!x",
	}, http.StatusCreated, &setup)
	if setup.InviteCode == "" {
		t.Fatal("setup returned no invite code")
	}

	// A fresh install is closed until the owner opens registration (invite
	// mode here). B4-1 renames the setting; accept either spelling while the
	// two are in flight.
	openRegistration(t, client, base, setup.Token)

	// Invite registration, then a fresh sign-in.
	var reg struct {
		Token string `json:"token"`
	}
	postJSONInto(t, client, base+"/api/v1/auth/register", "", map[string]any{
		"username": "captured", "password": "CapturedPass1!x", "invite_code": setup.InviteCode,
	}, http.StatusCreated, &reg)
	var login struct {
		Token string `json:"token"`
	}
	postJSONInto(t, client, base+"/api/v1/auth/login", "", map[string]any{
		"username": "captured", "password": "CapturedPass1!x",
	}, http.StatusOK, &login)
	if login.Token == "" {
		t.Fatal("login returned no token")
	}

	// The channel setup created, read over REST.
	var channels []struct {
		ID int64 `json:"id"`
	}
	getJSONInto(t, client, base+"/api/v1/channels", login.Token, &channels)
	if len(channels) == 0 {
		t.Fatal("no channel after setup")
	}
	getJSONInto(t, client, fmt.Sprintf("%s/api/v1/channels/%d/messages", base, channels[0].ID), login.Token, new(any))

	// A WebSocket session: auth, the ready payload, one message sent and
	// echoed back.
	wsURL := "ws://127.0.0.1:" + strconv.Itoa(port) + "/api/v1/ws"
	dialCtx, dialCancel := context.WithTimeout(ctx, 10*time.Second)
	defer dialCancel()
	conn, resp, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{HTTPClient: client})
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	authFrame, _ := json.Marshal(map[string]any{"type": "auth", "payload": map[string]any{"token": login.Token}})
	if err := conn.Write(dialCtx, websocket.MessageText, authFrame); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	for i := 0; i < 2; i++ { // auth_ok, ready
		if _, _, err := conn.Read(dialCtx); err != nil {
			t.Fatalf("read frame %d after auth: %v", i, err)
		}
	}
	sendFrame, _ := json.Marshal(map[string]any{"type": "chat_send", "payload": map[string]any{
		"channel_id": channels[0].ID, "content": "captured message",
	}})
	if err := conn.Write(dialCtx, websocket.MessageText, sendFrame); err != nil {
		t.Fatalf("write chat_send: %v", err)
	}
	if _, _, err := conn.Read(dialCtx); err != nil {
		t.Fatalf("read the send's reply: %v", err)
	}
	_ = conn.Close(websocket.StatusNormalClosure, "")

	// An upload.
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("file", "note.txt")
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	_, _ = part.Write([]byte("captured upload"))
	_ = mw.Close()
	req, _ := http.NewRequest(http.MethodPost, base+"/api/v1/uploads", &body)
	req.Header.Set("Authorization", "Bearer "+login.Token)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	upResp, err := client.Do(req)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	_, _ = io.Copy(io.Discard, upResp.Body)
	_ = upResp.Body.Close()
	if upResp.StatusCode != http.StatusCreated && upResp.StatusCode != http.StatusOK {
		t.Fatalf("upload status = %d", upResp.StatusCode)
	}

	// Idle, then shut down.
	time.Sleep(1500 * time.Millisecond)
	if err := stopServer(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	dials, lookups := rec.snapshot()
	for _, d := range dials {
		if !isLoopbackDial(d) {
			t.Errorf("the server dialled beyond loopback: %s", d)
		}
	}
	if lookups != 0 {
		t.Errorf("the server resolved %d name(s); loopback needs none", lookups)
	}

	// Positive control: the recorder sees a dial made through the default
	// transport, so an empty capture above means nothing was dialled.
	before := len(dials)
	ctrl, err := http.Get(base + "/health") //nolint:noctx // positive control on a stopped server; the error is the point
	if err == nil {
		_ = ctrl.Body.Close()
	}
	after, _ := rec.snapshot()
	if len(after) <= before || !isLoopbackDial(after[len(after)-1]) {
		t.Fatalf("recorder missed the control dial: before %d, after %v", before, after)
	}
}

// openRegistration sets invite-only registration through the admin API,
// under whichever key this tree uses (registration_mode from B4-1, the
// registration_open boolean before it).
func openRegistration(t *testing.T, client *http.Client, base, ownerToken string) {
	t.Helper()
	for _, body := range []map[string]any{
		{"registration_mode": "invite"},
		{"registration_open": "true"},
	} {
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest(http.MethodPatch, base+"/admin/api/settings", bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+ownerToken)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("PATCH settings: %v", err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return
		}
	}
	t.Fatal("could not open registration through the admin settings API")
}

func waitHealthy(t *testing.T, client *http.Client, url string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := client.Get(url) //nolint:noctx // test poll
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("server did not become healthy")
}

func postJSONInto(t *testing.T, client *http.Client, url, token string, body any, want int, into any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer resp.Body.Close() //nolint:errcheck
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		t.Fatalf("POST %s: status = %d, want %d; body = %s", url, resp.StatusCode, want, data)
	}
	if into != nil {
		if err := json.Unmarshal(data, into); err != nil {
			t.Fatalf("POST %s: decode: %v; body = %s", url, err, data)
		}
	}
}

func getJSONInto(t *testing.T, client *http.Client, url, token string, into any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close() //nolint:errcheck
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: status = %d; body = %s", url, resp.StatusCode, data)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("GET %s: decode: %v; body = %s", url, err, data)
	}
}
