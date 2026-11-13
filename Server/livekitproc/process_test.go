package livekitproc_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/livekitproc"
)

func TestNewLiveKitProcess(t *testing.T) {
	t.Parallel()

	cfg := testVoiceConfig("key", "secret")
	proc := newProcess(t, cfg)
	if proc == nil {
		t.Fatal("expected non-nil Process")
	}
}

func TestLiveKitProcess_Start_NoBinary(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:     "key",
		LiveKitAPISecret:  "secret",
		LiveKitURL:        "ws://localhost:7880",
		LiveKitBinaryPath: "", // empty → no-op
	}
	proc := newProcess(t, cfg)

	err := proc.Start()
	mustDo(t, "Start() with empty binary should return nil, got", err)
}

func TestLiveKitProcess_IsRunning_Default(t *testing.T) {
	t.Parallel()

	cfg := testVoiceConfig("key", "secret")
	proc := newProcess(t, cfg)

	if proc.IsRunning() {
		t.Fatal("expected IsRunning() = false before Start()")
	}
}

func TestLiveKitProcess_PID(t *testing.T) {
	t.Parallel()

	proc := livekitproc.New(&config.VoiceConfig{}, &config.TLSConfig{}, t.TempDir())
	if pid, ok := proc.PID(); ok {
		t.Fatalf("PID before Start = %d, true", pid)
	}
	proc.SetProcessCmdForTest() // a cmd that has not started has no Process
	if pid, ok := proc.PID(); ok {
		t.Fatalf("PID of an unstarted cmd = %d, true", pid)
	}
	proc.SetProcessPIDForTest(4321)
	if pid, ok := proc.PID(); !ok || pid != 4321 {
		t.Fatalf("PID = %d, %v; want 4321, true", pid, ok)
	}
}

func TestLiveKitProcess_Stop_BeforeStart(t *testing.T) {
	t.Parallel()

	cfg := testVoiceConfig("key", "secret")
	proc := newProcess(t, cfg)

	// Stop() before Start() should not panic.
	proc.Stop()

	// After Stop(), IsRunning should still be false.
	if proc.IsRunning() {
		t.Fatal("expected IsRunning() = false after Stop() without Start()")
	}
}

func TestGenerateConfig_TunesSpeakerDetection(t *testing.T) {
	t.Parallel()

	proc := livekitproc.New(&config.VoiceConfig{
		LiveKitAPIKey: "k", LiveKitAPISecret: "s", LiveKitURL: "ws://localhost:7880",
	}, &config.TLSConfig{}, t.TempDir())
	cfgPath, err := proc.GenerateConfigForTest()
	mustDo(t, "generateConfig", err)
	content, err := os.ReadFile(cfgPath)
	mustDo(t, "ReadFile", err)
	// LiveKit's defaults (400ms interval, 2 smoothing intervals, active_level 35)
	// light the speaking ring ~0.8s late and only for loud speech. At level 60
	// the ring the others see also lights for the soft speech a client sends.
	for _, want := range []string{
		"audio:\n  active_level: 60\n  min_percentile: 30\n  update_interval: 100\n  smooth_intervals: 1\n",
	} {
		if !strings.Contains(string(content), want) {
			t.Errorf("config missing %q.\nGot:\n%s", want, content)
		}
	}
}

func TestGenerateConfig_WritesYAML(t *testing.T) {
	t.Parallel()

	dataDir := t.TempDir()
	cfg := testVoiceConfig("testkey", "testsecret")
	proc := livekitproc.New(cfg, &config.TLSConfig{}, dataDir)

	cfgPath, err := proc.GenerateConfigForTest()
	mustDo(t, "generateConfig", err)

	content, err := os.ReadFile(cfgPath)
	mustDo(t, "reading config file", err)

	got := string(content)

	for _, want := range []string{
		"port: 7880",
		`"testkey": "testsecret"`,
		"port_range_start: 50000",
		"port_range_end: 60000",
		"use_external_ip: true",
		"level: info",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("config missing %q.\nGot:\n%s", want, got)
		}
	}

	if strings.Contains(got, "node_ip") {
		t.Error("config should not contain node_ip when NodeIP is empty")
	}
}

func TestGenerateConfig_WithNodeIP(t *testing.T) {
	t.Parallel()

	dataDir := t.TempDir()
	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key1",
		LiveKitAPISecret: "secret1",
		LiveKitURL:       "ws://localhost:7880",
		NodeIP:           "203.0.113.10",
	}
	proc := livekitproc.New(cfg, &config.TLSConfig{}, dataDir)

	cfgPath, err := proc.GenerateConfigForTest()
	mustDo(t, "generateConfig", err)

	content, err := os.ReadFile(cfgPath)
	mustDo(t, "reading config file", err)

	got := string(content)
	if !strings.Contains(got, `node_ip: "203.0.113.10"`) {
		t.Errorf("expected node_ip in config.\nGot:\n%s", got)
	}
}

// TestGenerateConfig_NodeIPReplacesExternalIP — LiveKit re-resolves node_ip
// over STUN whenever use_external_ip is on, so a pinned node_ip (a tailnet
// 100.x address, say) only takes effect when the generated file leaves
// use_external_ip out.
func TestGenerateConfig_NodeIPReplacesExternalIP(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name              string
		nodeIP            string
		advertiseInternal bool
		wantExternal      bool
		wantNodeIPSet     string
	}{
		{name: "empty node_ip auto-detects", nodeIP: "", wantExternal: true, wantNodeIPSet: ""},
		{name: "pinned node_ip is honoured", nodeIP: "100.64.0.7", wantExternal: false, wantNodeIPSet: "100.64.0.7"},
		{name: "advertise_internal_ip keeps discovery on", nodeIP: "203.0.113.10", advertiseInternal: true, wantExternal: true, wantNodeIPSet: "203.0.113.10"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			cfg := &config.VoiceConfig{
				LiveKitAPIKey:       "key1",
				LiveKitAPISecret:    "secret1",
				LiveKitURL:          "ws://localhost:7880",
				NodeIP:              tc.nodeIP,
				AdvertiseInternalIP: tc.advertiseInternal,
			}
			proc := livekitproc.New(cfg, &config.TLSConfig{}, t.TempDir())
			_, content := generatedConfig(t, proc)
			var parsed struct {
				RTC struct {
					UseExternalIP bool   `yaml:"use_external_ip"`
					NodeIP        string `yaml:"node_ip"`
				} `yaml:"rtc"`
			}
			if err := yaml.Unmarshal(content, &parsed); err != nil {
				t.Fatalf("generated livekit.yaml does not parse: %v\n%s", err, content)
			}
			if parsed.RTC.UseExternalIP != tc.wantExternal || parsed.RTC.NodeIP != tc.wantNodeIPSet {
				t.Errorf("rtc = {use_external_ip: %v, node_ip: %q}, want {%v, %q}",
					parsed.RTC.UseExternalIP, parsed.RTC.NodeIP, tc.wantExternal, tc.wantNodeIPSet)
			}
		})
	}
}

func TestGenerateConfig_UnsafeCredentialChars(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		key    string
		secret string
	}{
		{"colon in key", "bad:key", "secret"},
		{"newline in secret", "key", "bad\nsecret"},
		{"hash in key", "bad#key", "secret"},
		{"brace in secret", "key", "bad{secret"},
		{"backslash in key", `bad\key`, "secret"},
		{"quote in secret", "key", `bad"secret`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			cfg := &config.VoiceConfig{
				LiveKitAPIKey:    tt.key,
				LiveKitAPISecret: tt.secret,
				LiveKitURL:       "ws://localhost:7880",
			}
			proc := newProcess(t, cfg)

			_, err := proc.GenerateConfigForTest()
			if err == nil {
				t.Error("expected error for unsafe YAML character, got nil")
			}
		})
	}
}

// The rejection error is wrapped by Start() and logged by the caller, so it
// must never echo any part of the credential it rejected — quoting even the
// single offending byte writes a piece of a secret to the server log in clear
// text (CodeQL go/clear-text-logging). It must still name the field at fault.
func TestGenerateConfig_UnsafeCredentialErrorDoesNotLeakCredential(t *testing.T) {
	t.Parallel()

	const (
		key    = "sup3rsecret:apikey"
		secret = "sup3rsecret{apisecret"
	)

	for _, tt := range []struct {
		name  string
		key   string
		sec   string
		field string
		leak  string
	}{
		{"key", key, "safesecret", "voice.livekit_api_key", key},
		{"secret", "safekey", secret, "voice.livekit_api_secret", secret},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			proc := livekitproc.New(&config.VoiceConfig{
				LiveKitAPIKey:    tt.key,
				LiveKitAPISecret: tt.sec,
				LiveKitURL:       "ws://localhost:7880",
			}, &config.TLSConfig{}, t.TempDir())

			_, err := proc.GenerateConfigForTest()
			if err == nil {
				t.Fatal("expected an error for the unsafe credential, got nil")
			}
			msg := err.Error()
			if strings.Contains(msg, tt.leak) {
				t.Errorf("error leaks the credential verbatim: %q", msg)
			}
			// The distinctive prefix must not appear even partially quoted.
			if strings.Contains(msg, "sup3rsecret") {
				t.Errorf("error leaks part of the credential: %q", msg)
			}
			if !strings.Contains(msg, tt.field) {
				t.Errorf("error should name the offending field %q, got %q", tt.field, msg)
			}
		})
	}
}

func TestGenerateConfig_UnsafeNodeIPChars(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "safekey",
		LiveKitAPISecret: "safesecret",
		LiveKitURL:       "ws://localhost:7880",
		NodeIP:           "192.168.1.1\n  evil: true",
	}
	proc := newProcess(t, cfg)

	_, err := proc.GenerateConfigForTest()
	if err == nil {
		t.Error("expected error for unsafe node_ip character, got nil")
	}
}

func TestGenerateConfig_WithAdvertiseInternalIP(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:       "key1",
		LiveKitAPISecret:    "secret1",
		LiveKitURL:          "ws://localhost:7880",
		NodeIP:              "203.0.113.10",
		AdvertiseInternalIP: true,
	}
	proc := livekitproc.New(cfg, &config.TLSConfig{}, t.TempDir())

	_, content := generatedConfig(t, proc)

	got := string(content)
	if !strings.Contains(got, "advertise_internal_ip: true") {
		t.Errorf("expected advertise_internal_ip in config.\nGot:\n%s", got)
	}
	if !strings.Contains(got, `node_ip: "203.0.113.10"`) {
		t.Errorf("expected node_ip alongside advertise_internal_ip.\nGot:\n%s", got)
	}
}

func TestGenerateConfig_DefaultOmitsAdvertiseInternalIP(t *testing.T) {
	t.Parallel()

	cfg := testVoiceConfig("key1", "secret1")
	proc := livekitproc.New(cfg, &config.TLSConfig{}, t.TempDir())

	_, content := generatedConfig(t, proc)

	if strings.Contains(string(content), "advertise_internal_ip") {
		t.Error("config should not contain advertise_internal_ip by default")
	}
}

func TestGenerateConfig_PreservesUserManagedFile(t *testing.T) {
	t.Parallel()

	dataDir := t.TempDir()
	cfgPath := filepath.Join(dataDir, "livekit.yaml")
	userContent := "# my custom livekit config\nport: 7880\nrtc:\n  ips:\n    includes: [10.0.0.0/8]\n"
	mustDo(t, "writing user config", os.WriteFile(cfgPath, []byte(userContent), 0o600))

	cfg := testVoiceConfig("key1", "secret1")
	proc := livekitproc.New(cfg, &config.TLSConfig{}, dataDir)

	gotPath, err := proc.GenerateConfigForTest()
	mustDo(t, "generateConfig", err)
	if gotPath != cfgPath {
		t.Errorf("expected path %q, got %q", cfgPath, gotPath)
	}

	content, err := os.ReadFile(cfgPath)
	mustDo(t, "reading config file", err)
	if string(content) != userContent {
		t.Errorf("user-managed livekit.yaml was modified.\nWant:\n%s\nGot:\n%s", userContent, content)
	}
}

func TestGenerateConfig_RegeneratesEmptyFile(t *testing.T) {
	t.Parallel()

	dataDir := t.TempDir()
	cfgPath := filepath.Join(dataDir, "livekit.yaml")
	// A zero-byte/whitespace-only file is a truncated leftover, not a
	// user-managed config — it must be regenerated.
	mustDo(t, "writing empty config", os.WriteFile(cfgPath, []byte("  \n"), 0o600))

	cfg := testVoiceConfig("key1", "secret1")
	proc := livekitproc.New(cfg, &config.TLSConfig{}, dataDir)

	if _, err := proc.GenerateConfigForTest(); err != nil {
		t.Fatalf("generateConfig: %v", err)
	}
	content, err := os.ReadFile(cfgPath)
	mustDo(t, "reading config file", err)
	if !strings.Contains(string(content), `"key1": "secret1"`) {
		t.Errorf("empty livekit.yaml was not regenerated.\nGot:\n%s", content)
	}
}

func TestGenerateConfig_OverwritesAutoGeneratedFile(t *testing.T) {
	t.Parallel()

	dataDir := t.TempDir()
	cfgPath := filepath.Join(dataDir, "livekit.yaml")
	old := "# Auto-generated by OwnCord — do not edit manually.\nport: 7880\nstale: true\n"
	mustDo(t, "writing old config", os.WriteFile(cfgPath, []byte(old), 0o600))

	cfg := testVoiceConfig("key1", "secret1")
	proc := livekitproc.New(cfg, &config.TLSConfig{}, dataDir)

	if _, err := proc.GenerateConfigForTest(); err != nil {
		t.Fatalf("generateConfig: %v", err)
	}

	content, err := os.ReadFile(cfgPath)
	mustDo(t, "reading config file", err)
	got := string(content)
	if strings.Contains(got, "stale: true") {
		t.Error("auto-generated livekit.yaml was not regenerated")
	}
	if !strings.Contains(got, `"key1": "secret1"`) {
		t.Errorf("regenerated config missing keys.\nGot:\n%s", got)
	}
}

func TestStart_AlreadyRunningGuard(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:     "key",
		LiveKitAPISecret:  "secret",
		LiveKitURL:        "ws://localhost:7880",
		LiveKitBinaryPath: "/nonexistent/livekit-server",
	}
	proc := newProcess(t, cfg)

	proc.SetProcessCmdForTest()

	err := proc.Start()
	if err == nil {
		t.Fatal("expected error when process already running, got nil")
	}
	if !strings.Contains(err.Error(), "already running") {
		t.Errorf("expected 'already running' error, got: %v", err)
	}
}

func TestStart_StoppedGuard(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:     "key",
		LiveKitAPISecret:  "secret",
		LiveKitURL:        "ws://localhost:7880",
		LiveKitBinaryPath: "/nonexistent/livekit-server",
	}
	proc := newProcess(t, cfg)

	proc.SetProcessStoppedForTest()

	err := proc.Start()
	mustDo(t, "Start() on stopped process returned error", err)

	proc.Stop()
	if proc.IsRunning() {
		t.Error("expected IsRunning() = false after Stop()")
	}
}

func TestHealthCheck_Success(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	wsURL := "ws://" + srv.Listener.Addr().String()

	proc := newProcess(t, testVoiceConfigAt(wsURL))

	ok, err := proc.HealthCheck(context.Background())
	mustDo(t, "HealthCheck", err)
	if !ok {
		t.Error("expected HealthCheck to return true")
	}
}

// httptest.Server.Close calls CloseIdleConnections on the process-wide
// http.DefaultTransport, so a health-check client that falls back to it can have
// a pooled connection severed mid-request by any unrelated parallel test closing
// its own server ("http: CloseIdleConnections called"). The client must own its
// transport — in production that also keeps the health check off the connection
// pool every other DefaultTransport user in the process shares.
func TestHealthCheckClientOwnsItsTransport(t *testing.T) {
	t.Parallel()

	proc := livekitproc.New(&config.VoiceConfig{}, &config.TLSConfig{}, t.TempDir())

	tr := proc.HTTPTransportForTest()
	if tr == nil {
		t.Fatal("health-check client has no Transport, so it falls back to http.DefaultTransport")
	}
	if tr == http.DefaultTransport {
		t.Error("health-check client shares http.DefaultTransport's connection pool")
	}
}

func TestHealthCheck_ServerDown(t *testing.T) {
	t.Parallel()

	proc := newProcess(t, testVoiceConfigAt("ws://127.0.0.1:1"))

	ok, err := proc.HealthCheck(context.Background())
	if err == nil {
		t.Fatal("expected error for unreachable server, got nil")
	}
	if ok {
		t.Error("expected HealthCheck to return false on error")
	}
}

func TestHealthCheck_NonOKStatus(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	wsURL := "ws://" + srv.Listener.Addr().String()
	proc := newProcess(t, testVoiceConfigAt(wsURL))

	ok, err := proc.HealthCheck(context.Background())
	mustDo(t, "HealthCheck", err)
	if !ok {
		t.Error("expected HealthCheck to return true even for 500 status")
	}
}
