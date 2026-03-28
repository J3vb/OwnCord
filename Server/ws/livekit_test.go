package ws_test

import (
	"testing"

	"github.com/owncord/server/config"
	"github.com/owncord/server/ws"
)

// ---------------------------------------------------------------------------
// livekit.go tests
// ---------------------------------------------------------------------------

func TestWsToHTTP(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{"ws to http", "ws://localhost:7880", "http://localhost:7880"},
		{"wss to https", "wss://livekit.example.com", "https://livekit.example.com"},
		{"http passthrough", "http://localhost:7880", "http://localhost:7880"},
		{"https passthrough", "https://livekit.example.com", "https://livekit.example.com"},
		{"empty string", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := ws.WsToHTTPForTest(tt.in)
			if got != tt.want {
				t.Errorf("wsToHTTP(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestRoomName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		channelID int64
		want      string
	}{
		{1, "channel-1"},
		{42, "channel-42"},
		{0, "channel-0"},
		{999999, "channel-999999"},
	}

	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			t.Parallel()
			got := ws.RoomName(tt.channelID)
			if got != tt.want {
				t.Errorf("RoomName(%d) = %q, want %q", tt.channelID, got, tt.want)
			}
		})
	}
}

func TestNewLiveKitClient_MissingConfig(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		cfg  config.VoiceConfig
	}{
		{
			"empty api key",
			config.VoiceConfig{
				LiveKitAPIKey:    "",
				LiveKitAPISecret: "some-secret",
				LiveKitURL:       "ws://localhost:7880",
			},
		},
		{
			"empty api secret",
			config.VoiceConfig{
				LiveKitAPIKey:    "some-key",
				LiveKitAPISecret: "",
				LiveKitURL:       "ws://localhost:7880",
			},
		},
		{
			"empty url",
			config.VoiceConfig{
				LiveKitAPIKey:    "some-key",
				LiveKitAPISecret: "some-secret",
				LiveKitURL:       "",
			},
		},
		{
			"all empty",
			config.VoiceConfig{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			client, err := ws.NewLiveKitClient(&tt.cfg)
			if err == nil {
				t.Fatal("expected error for missing config, got nil")
			}
			if client != nil {
				t.Fatal("expected nil client on error")
			}
		})
	}
}

func TestGenerateToken_ValidToken(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "test-key",
		LiveKitAPISecret: "test-secret-that-is-long-enough-for-hmac",
		LiveKitURL:       "ws://localhost:7880",
	}

	client, err := ws.NewLiveKitClient(cfg)
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}

	token, err := client.GenerateToken(123, "testuser", 456, true, true)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if token == "" {
		t.Fatal("expected non-empty JWT token")
	}

	// JWT tokens have three dot-separated parts.
	parts := 0
	for _, b := range token {
		if b == '.' {
			parts++
		}
	}
	if parts != 2 {
		t.Errorf("expected JWT with 2 dots (3 parts), got %d dots in %q", parts, token)
	}
}

func TestGenerateToken_DifferentPermissions(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "test-key",
		LiveKitAPISecret: "test-secret-that-is-long-enough-for-hmac",
		LiveKitURL:       "ws://localhost:7880",
	}

	client, err := ws.NewLiveKitClient(cfg)
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}

	// Subscribe-only token (canPublish=false).
	token, err := client.GenerateToken(1, "listener", 10, false, true)
	if err != nil {
		t.Fatalf("GenerateToken(subscribe-only): %v", err)
	}
	if token == "" {
		t.Fatal("expected non-empty token for subscribe-only")
	}
}

// ---------------------------------------------------------------------------
// livekit_process.go tests
// ---------------------------------------------------------------------------

func TestNewLiveKitProcess(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key",
		LiveKitAPISecret: "secret",
		LiveKitURL:       "ws://localhost:7880",
	}
	tlsCfg := &config.TLSConfig{}

	proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())
	if proc == nil {
		t.Fatal("expected non-nil LiveKitProcess")
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
	tlsCfg := &config.TLSConfig{}

	proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())

	err := proc.Start()
	if err != nil {
		t.Fatalf("Start() with empty binary should return nil, got: %v", err)
	}
}

func TestLiveKitProcess_IsRunning_Default(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key",
		LiveKitAPISecret: "secret",
		LiveKitURL:       "ws://localhost:7880",
	}
	tlsCfg := &config.TLSConfig{}

	proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())

	if proc.IsRunning() {
		t.Fatal("expected IsRunning() = false before Start()")
	}
}

func TestLiveKitProcess_Stop_BeforeStart(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key",
		LiveKitAPISecret: "secret",
		LiveKitURL:       "ws://localhost:7880",
	}
	tlsCfg := &config.TLSConfig{}

	proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())

	// Stop() before Start() should not panic.
	proc.Stop()

	// After Stop(), IsRunning should still be false.
	if proc.IsRunning() {
		t.Fatal("expected IsRunning() = false after Stop() without Start()")
	}
}

// ---------------------------------------------------------------------------
// livekit_webhook.go tests
// ---------------------------------------------------------------------------

func TestParseIdentity_Valid(t *testing.T) {
	t.Parallel()

	id, err := ws.ParseIdentityForTest("user-123")
	if err != nil {
		t.Fatalf("parseIdentity(\"user-123\"): unexpected error: %v", err)
	}
	if id != 123 {
		t.Errorf("parseIdentity(\"user-123\") = %d, want 123", id)
	}
}

func TestParseIdentity_Invalid(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
	}{
		{"no prefix", "invalid"},
		{"empty id", "user-"},
		{"non-numeric", "user-abc"},
		{"wrong prefix", "admin-123"},
		{"empty string", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := ws.ParseIdentityForTest(tt.input)
			if err == nil {
				t.Errorf("parseIdentity(%q): expected error, got nil", tt.input)
			}
		})
	}
}

func TestParseRoomChannelID_Valid(t *testing.T) {
	t.Parallel()

	id, err := ws.ParseRoomChannelIDForTest("channel-456")
	if err != nil {
		t.Fatalf("parseRoomChannelID(\"channel-456\"): unexpected error: %v", err)
	}
	if id != 456 {
		t.Errorf("parseRoomChannelID(\"channel-456\") = %d, want 456", id)
	}
}

func TestParseRoomChannelID_Invalid(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
	}{
		{"no prefix", "invalid"},
		{"non-numeric", "channel-abc"},
		{"wrong prefix", "room-123"},
		{"empty string", ""},
		{"empty id", "channel-"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := ws.ParseRoomChannelIDForTest(tt.input)
			if err == nil {
				t.Errorf("parseRoomChannelID(%q): expected error, got nil", tt.input)
			}
		})
	}
}
