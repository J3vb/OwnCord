package api_test

// router_livekit_process_test.go pins the production wiring for OC-0019:
// when OwnCord is configured to manage its own companion LiveKit process
// (voice.auto_download_livekit or voice.livekit_binary set) and
// LiveKitProcess.Start() fails synchronously (e.g. generateConfig rejects an
// operator-chosen credential containing a YAML-unsafe character), NewRouter
// must still register the process with the hub so the voice_join guard in
// ws/voice_join.go — `if h.lkProcess != nil && !h.lkProcess.IsRunning()` —
// fails CLOSED. Before the fix, router.go skipped hub.SetLiveKitProcess on
// the Start() error path, leaving h.lkProcess nil, which reads as "LiveKit
// is externally managed" and lets voice_join proceed with no SFU running at
// all: a voice_states row gets persisted, a LiveKit JWT gets minted, and
// voice_state fans out to every client for a room nothing is serving.
//
// This test drives the real api.NewRouter wiring end to end over a live
// WebSocket connection, so it fails if the router ever again drops the
// process on a failed Start().

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/app"
)

// voiceJoinWSMsg builds a raw voice_join WebSocket frame for the given channel.
func voiceJoinWSMsg(channelID int64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": channelID},
	})
	return raw
}

func TestNewRouter_LiveKitProcessStartFailure_VoiceJoinFailsClosed(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	cfg := &config.Config{
		Server: config.ServerConfig{
			Name:           "Test Server",
			Port:           8443,
			DataDir:        t.TempDir(),
			AllowedOrigins: []string{"*"},
		},
		Voice: config.VoiceConfig{
			// Non-default, non-empty credentials so NewLiveKitClient succeeds
			// and hub.SetLiveKit runs (router.go:162) — voice looks
			// "configured". The colon in the secret is the ordinary
			// credential character that trips livekit_process.go's unsafeYAML
			// check inside generateConfig, so proc.Start() fails
			// synchronously, before any goroutine or network call.
			LiveKitAPIKey:       "test-livekit-key-oc0019",
			LiveKitAPISecret:    "prod:livekit:secret-at-least-32-chars-long",
			LiveKitURL:          "ws://localhost:7880",
			AutoDownloadLiveKit: true,
		},
	}

	rt := app.StartRuntime(cfg, database, nil)
	handler, cleanup := api.NewRouter(cfg, database, "test", nil, nil, rt)
	t.Cleanup(cleanup)

	// role_id=1 -> Owner, so CONNECT_VOICE is granted and the test isolates
	// the LiveKit-process guard rather than a permission check.
	uid, err := database.CreateUser(context.Background(), "oc0019voiceuser", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	channelID, err := database.CreateChannel(context.Background(), "oc0019-voice", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	conn := dialAndAuthWS(t, srv, token)

	writeCtx, writeCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer writeCancel()
	if err := conn.Write(writeCtx, websocket.MessageText, voiceJoinWSMsg(channelID)); err != nil {
		t.Fatalf("write voice_join: %v", err)
	}

	// Read frames until we see a response to the join attempt (skipping the
	// "ready" hydration frame and any other unrelated broadcasts), or time out.
	deadline := time.Now().Add(10 * time.Second)
	var lastFrame map[string]any
	for time.Now().Before(deadline) {
		readCtx, readCancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, msg, readErr := conn.Read(readCtx)
		readCancel()
		if readErr != nil {
			break
		}
		var frame map[string]any
		if err := json.Unmarshal(msg, &frame); err != nil {
			continue
		}
		switch frame["type"] {
		case "ready", "voice_config":
			continue
		case "error", "voice_token":
			lastFrame = frame
		}
		if lastFrame != nil {
			break
		}
	}

	if lastFrame == nil {
		t.Fatal("no error or voice_token response observed for voice_join before the deadline")
	}

	if lastFrame["type"] != "error" {
		t.Fatalf("voice_join with a LiveKit process that failed to start must be rejected, got type=%v frame=%v — "+
			"router.go must register the LiveKitProcess with the hub even when proc.Start() fails, "+
			"so ws/voice_join.go's `h.lkProcess != nil && !h.lkProcess.IsRunning()` guard can fail closed "+
			"instead of reading a dropped process as \"externally managed, don't check\"",
			lastFrame["type"], lastFrame)
	}

	payload, _ := lastFrame["payload"].(map[string]any)
	if payload["code"] != "VOICE_ERROR" {
		t.Fatalf("expected error code VOICE_ERROR, got %v (frame=%v)", payload["code"], lastFrame)
	}
}
