package ws

import (
	"encoding/json"
	"testing"
	"testing/fstest"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
)

// renegTestSchema is a minimal schema for renegotiation tests.
var renegTestSchema = []byte(`
CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    color       TEXT,
    permissions INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    is_default  INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO roles (id, name, color, permissions, position, is_default) VALUES
    (1, 'Owner', '#E74C3C', 2147483647, 100, 0),
    (4, 'Member', NULL, 1635, 40, 1);

CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password    TEXT    NOT NULL,
    avatar      TEXT,
    role_id     INTEGER NOT NULL DEFAULT 4 REFERENCES roles(id),
    totp_secret TEXT,
    status      TEXT    NOT NULL DEFAULT 'offline',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT,
    banned      INTEGER NOT NULL DEFAULT 0,
    ban_reason  TEXT,
    ban_expires TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    device     TEXT,
    ip_address TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    type             TEXT    NOT NULL DEFAULT 'text',
    category         TEXT,
    topic            TEXT,
    position         INTEGER NOT NULL DEFAULT 0,
    slow_mode        INTEGER NOT NULL DEFAULT 0,
    archived         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    voice_max_users  INTEGER NOT NULL DEFAULT 0,
    voice_quality    TEXT,
    mixing_threshold INTEGER,
    voice_max_video  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channel_overrides (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles(id)    ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(channel_id, role_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    content    TEXT    NOT NULL,
    reply_to   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    edited_at  TEXT,
    deleted    INTEGER NOT NULL DEFAULT 0,
    pinned     INTEGER NOT NULL DEFAULT 0,
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS voice_states (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    muted       INTEGER NOT NULL DEFAULT 0,
    deafened    INTEGER NOT NULL DEFAULT 0,
    speaking    INTEGER NOT NULL DEFAULT 0,
    camera      INTEGER NOT NULL DEFAULT 0,
    screenshare INTEGER NOT NULL DEFAULT 0,
    joined_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_states_channel ON voice_states(channel_id);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('server_name', 'Test Server');
INSERT OR IGNORE INTO settings (key, value) VALUES ('motd', 'Welcome');
`)

// newRenegTestDB opens an in-memory DB with the renegotiation test schema.
func newRenegTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: renegTestSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

// newRenegHub creates a hub suitable for renegotiation tests.
func newRenegHub(t *testing.T) (*Hub, *db.DB) {
	t.Helper()
	database := newRenegTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := NewHub(database, limiter)
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	return hub, database
}

// newTestSFU creates an SFU for tests with a small port range.
func newTestSFU(t *testing.T) *SFU {
	t.Helper()
	cfg := &config.VoiceConfig{
		Quality:      "medium",
		MediaPortMin: 50000,
		MediaPortMax: 50100,
	}
	sfu, err := NewSFU(cfg)
	if err != nil {
		t.Fatalf("NewSFU: %v", err)
	}
	t.Cleanup(func() { sfu.Close() })
	return sfu
}

// seedRenegUser inserts an Owner-role user for renegotiation tests.
func seedRenegUser(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	_, err := database.CreateUser(username, "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername(username)
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	return user
}

// TestRenegotiateParticipant_SkipsHaveRemoteOffer verifies that when the
// PeerConnection is in have-remote-offer state, renegotiateParticipant
// returns early without creating a new offer.
func TestRenegotiateParticipant_SkipsHaveRemoteOffer(t *testing.T) {
	hub, database := newRenegHub(t)
	sfu := newTestSFU(t)
	user := seedRenegUser(t, database, "skip-remote-offer")

	send := make(chan []byte, 32)
	c := NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Create a server-side PC via the SFU.
	serverPC, err := sfu.NewPeerConnection()
	if err != nil {
		t.Fatalf("NewPeerConnection: %v", err)
	}
	t.Cleanup(func() { _ = serverPC.Close() })

	// Create a client-side PC to generate a valid offer.
	clientPC, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("NewPeerConnection (client): %v", err)
	}
	t.Cleanup(func() { _ = clientPC.Close() })

	// Add a transceiver on the client so the offer has media.
	_, err = clientPC.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendrecv,
	})
	if err != nil {
		t.Fatalf("AddTransceiverFromKind: %v", err)
	}

	clientOffer, err := clientPC.CreateOffer(nil)
	if err != nil {
		t.Fatalf("CreateOffer (client): %v", err)
	}
	if err := clientPC.SetLocalDescription(clientOffer); err != nil {
		t.Fatalf("SetLocalDescription (client): %v", err)
	}

	// Set the client's offer as the server PC's remote description,
	// putting it into have-remote-offer state.
	if err := serverPC.SetRemoteDescription(clientOffer); err != nil {
		t.Fatalf("SetRemoteDescription (server): %v", err)
	}

	if serverPC.SignalingState() != webrtc.SignalingStateHaveRemoteOffer {
		t.Fatalf("expected have-remote-offer, got %s", serverPC.SignalingState())
	}

	// Attach the server PC to the client.
	c.setVoice(1, serverPC)

	// Drain any messages that were sent during setup.
	drainSend(send)

	// Call renegotiateParticipant — it should skip (no offer sent).
	hub.renegotiateParticipant(c)
	time.Sleep(50 * time.Millisecond)

	// Verify no voice_offer was sent.
	msgs := drainSend(send)
	for _, msg := range msgs {
		typ := extractMsgType(t, msg)
		if typ == "voice_offer" {
			t.Error("renegotiateParticipant should skip in have-remote-offer state, but sent a voice_offer")
		}
	}
}

// TestRenegotiateParticipant_RollsBackHaveLocalOffer verifies that when the
// PeerConnection already has a pending local offer, renegotiateParticipant
// attempts a rollback. Pion v4 does not support SDPTypeRollback, so the
// rollback fails and the function returns early without sending a new offer.
// This test documents the current behavior and ensures graceful handling.
func TestRenegotiateParticipant_RollsBackHaveLocalOffer(t *testing.T) {
	hub, database := newRenegHub(t)
	sfu := newTestSFU(t)
	user := seedRenegUser(t, database, "rollback-local-offer")

	send := make(chan []byte, 32)
	c := NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Create a server-side PC.
	serverPC, err := sfu.NewPeerConnection()
	if err != nil {
		t.Fatalf("NewPeerConnection: %v", err)
	}
	t.Cleanup(func() { _ = serverPC.Close() })

	// Add a transceiver so offers contain media.
	_, err = serverPC.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendrecv,
	})
	if err != nil {
		t.Fatalf("AddTransceiverFromKind: %v", err)
	}

	// Put the server PC into have-local-offer state by creating and setting
	// an offer manually.
	initialOffer, err := serverPC.CreateOffer(nil)
	if err != nil {
		t.Fatalf("CreateOffer: %v", err)
	}
	if err := serverPC.SetLocalDescription(initialOffer); err != nil {
		t.Fatalf("SetLocalDescription: %v", err)
	}
	if serverPC.SignalingState() != webrtc.SignalingStateHaveLocalOffer {
		t.Fatalf("expected have-local-offer, got %s", serverPC.SignalingState())
	}

	// Attach the server PC to the client with a voice channel ID.
	c.setVoice(1, serverPC)

	// Drain setup messages.
	drainSend(send)

	// Call renegotiateParticipant — it attempts rollback which fails in Pion v4,
	// so it returns early without sending a new offer.
	hub.renegotiateParticipant(c)
	time.Sleep(50 * time.Millisecond)

	// Verify no voice_offer was sent (rollback failed, function returned early).
	msgs := drainSend(send)
	for _, msg := range msgs {
		typ := extractMsgType(t, msg)
		if typ == "voice_offer" {
			t.Error("renegotiateParticipant should return early when rollback fails, but sent a voice_offer")
		}
	}

	// The PC remains in have-local-offer since rollback failed.
	if serverPC.SignalingState() != webrtc.SignalingStateHaveLocalOffer {
		t.Errorf("expected have-local-offer (unchanged after failed rollback), got %s", serverPC.SignalingState())
	}
}

// TestHandleVoiceOffer_RollsBackOnGlare verifies glare condition handling:
// when the server has a pending local offer and the client sends an offer
// simultaneously. The code attempts to rollback the server's offer before
// accepting the client's. Since Pion v4 does not support SDPTypeRollback,
// the rollback fails and handleVoiceOffer sends a VOICE_ERROR to the client.
// This test documents the current behavior and ensures graceful error handling.
func TestHandleVoiceOffer_RollsBackOnGlare(t *testing.T) {
	hub, database := newRenegHub(t)
	sfu := newTestSFU(t)
	user := seedRenegUser(t, database, "glare-rollback")

	send := make(chan []byte, 32)
	c := NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Create a server-side PC via the SFU.
	serverPC, err := sfu.NewPeerConnection()
	if err != nil {
		t.Fatalf("NewPeerConnection (server): %v", err)
	}
	t.Cleanup(func() { _ = serverPC.Close() })

	// Create a client-side PC to generate a valid offer.
	clientPC, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("NewPeerConnection (client): %v", err)
	}
	t.Cleanup(func() { _ = clientPC.Close() })

	// Add audio transceivers on both sides.
	_, err = serverPC.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendrecv,
	})
	if err != nil {
		t.Fatalf("AddTransceiverFromKind (server): %v", err)
	}

	_, err = clientPC.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendrecv,
	})
	if err != nil {
		t.Fatalf("AddTransceiverFromKind (client): %v", err)
	}

	// Put the server PC into have-local-offer state (server sent an offer).
	serverOffer, err := serverPC.CreateOffer(nil)
	if err != nil {
		t.Fatalf("CreateOffer (server): %v", err)
	}
	if err := serverPC.SetLocalDescription(serverOffer); err != nil {
		t.Fatalf("SetLocalDescription (server): %v", err)
	}
	if serverPC.SignalingState() != webrtc.SignalingStateHaveLocalOffer {
		t.Fatalf("expected server in have-local-offer, got %s", serverPC.SignalingState())
	}

	// Attach the server PC to the client.
	chanID := int64(42)
	c.setVoice(chanID, serverPC)

	// Generate a client offer (simulating the client also sending an offer).
	clientOffer, err := clientPC.CreateOffer(nil)
	if err != nil {
		t.Fatalf("CreateOffer (client): %v", err)
	}
	if err := clientPC.SetLocalDescription(clientOffer); err != nil {
		t.Fatalf("SetLocalDescription (client): %v", err)
	}

	// Drain any messages from setup.
	drainSend(send)

	// Build and dispatch the voice_offer payload as handleVoiceOffer expects.
	payload, _ := json.Marshal(map[string]any{
		"channel_id": chanID,
		"sdp":        clientOffer.SDP,
	})

	hub.handleVoiceOffer(c, payload)
	time.Sleep(50 * time.Millisecond)

	// Since Pion v4 does not support rollback, the glare path sends a
	// VOICE_ERROR back to the client indicating the conflict could not
	// be resolved.
	msgs := drainSend(send)
	foundError := false
	for _, msg := range msgs {
		typ := extractMsgType(t, msg)
		if typ == "error" {
			foundError = true
			// Verify the error code is VOICE_ERROR (signaling conflict).
			var env struct {
				Payload struct {
					Code string `json:"code"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(msg, &env); err != nil {
				t.Fatalf("failed to parse error message: %v", err)
			}
			if env.Payload.Code != "VOICE_ERROR" {
				t.Errorf("expected error code VOICE_ERROR, got %q", env.Payload.Code)
			}
		}
		if typ == "voice_answer" {
			t.Error("should not produce a voice_answer when rollback fails")
		}
	}
	if !foundError {
		t.Error("handleVoiceOffer should send a VOICE_ERROR when glare rollback fails, but no error was sent")
	}

	// The server PC remains in have-local-offer since rollback failed.
	if serverPC.SignalingState() != webrtc.SignalingStateHaveLocalOffer {
		t.Errorf("expected have-local-offer (unchanged after failed rollback), got %s", serverPC.SignalingState())
	}
}

// drainSend reads all pending messages from a channel.
func drainSend(ch chan []byte) [][]byte {
	var msgs [][]byte
	for {
		select {
		case m := <-ch:
			msgs = append(msgs, m)
		default:
			return msgs
		}
	}
}

// extractMsgType parses a JSON message and returns the "type" field.
func extractMsgType(t *testing.T, msg []byte) string {
	t.Helper()
	var env map[string]any
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("extractMsgType unmarshal: %v", err)
	}
	typ, _ := env["type"].(string)
	return typ
}
