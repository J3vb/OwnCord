package ws

// oc_0276_voice_e2ee_resync_test.go — regression test for finding OC-0276.
//
// voice_e2ee_announce is delivered as an unsequenced pub/sub frame:
// sendToVoiceChannelExcept (voice_e2ee.go) publishes straight onto the
// VoiceTopic via h.pubsub.Publish, bypassing h.broadcast/deliverBroadcast
// entirely. It therefore never gets a seq, is never pushed to h.replayBuf,
// and is never persisted — so neither reconnect replay tier (buffer or DB)
// can ever redeliver one that was queued for a socket that was down when it
// was sent. voiceJoinComplete (voice_join.go) is the ONLY other place the
// server relays a peer's stored ECDH public key, and that runs solely on a
// brand-new voice_join, never on a resume.
//
// Concretely: a client whose WebSocket blips and resumes (registerNow
// transfers its still-completed voice join onto the new connection, see
// OC-0270) never recovers a peer's key — or a mid-call key rotation — that
// went out while the socket was down, permanently desyncing its local
// peer-key map from the room roster even though its voice roster (which IS
// sequenced and replayed) stays correct.

import (
	"encoding/json"
	"testing"

	"github.com/owncord/server/auth"
)

func TestRegisterNow_ResyncsPeerE2EEKeyOnResume(t *testing.T) {
	database := newTeardownTestDB(t)
	hub := NewHub(database, auth.NewRateLimiter(), nil)

	const (
		chanID = int64(500)
		peerID = int64(1)
		userID = int64(2) // the resuming client
	)

	// Peer is already connected and in the voice channel, with a stored ECDH
	// public key from an earlier voice_e2ee_announce (as if it announced, or
	// re-announced on a LiveKit reconnect, while userID's socket was down).
	peerSend := make(chan []byte, 8)
	peer := &Client{userID: peerID, send: peerSend, sendHigh: peerSend, sendLow: peerSend}
	peer.voiceChID = chanID
	peer.e2eePubKey = "peer-pub-key-b64"
	hub.mu.Lock()
	hub.clients[peerID] = peer
	hub.mu.Unlock()

	// userID's PREVIOUS connection, still registered, with a completed voice
	// join for the same channel (voiceJoinCompleted=true) — this is exactly
	// what registerNow transfers onto a resuming connection per OC-0270.
	oldSend := make(chan []byte, 8)
	old := &Client{userID: userID, send: oldSend, sendHigh: oldSend, sendLow: oldSend}
	old.voiceChID = chanID
	old.voiceJoinToken = "join-token"
	old.voiceJoinCompleted = true
	hub.mu.Lock()
	hub.clients[userID] = old
	hub.mu.Unlock()

	// The resuming connection: lastSeq > 0 marks this as a network reconnect
	// (registerNow only transfers voice state on this path) rather than a
	// fresh login.
	newSend := make(chan []byte, 8)
	newC := &Client{userID: userID, send: newSend, sendHigh: newSend, sendLow: newSend, lastSeq: 1}

	hub.registerNow(newC, nil)

	if got := newC.getVoiceChID(); got != chanID {
		t.Fatalf("precondition failed: resumed client's voice state was not transferred, got channel %d want %d", got, chanID)
	}

	close(newSend)
	var gotAnnounce bool
	for msg := range newSend {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				UserID    int64  `json:"user_id"`
				PublicKey string `json:"public_key"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatalf("unmarshal message sent to resumed client: %v (raw=%s)", err, msg)
		}
		if env.Type == MsgTypeVoiceE2EEAnnounceBC && env.Payload.UserID == peerID && env.Payload.PublicKey == peer.e2eePubKey {
			gotAnnounce = true
		}
	}
	if !gotAnnounce {
		t.Error("resumed client never received the peer's stored ECDH public key (voice_e2ee_announce) on reconnect — " +
			"OC-0276: the server's only relay of an existing participant's key runs on a fresh voice_join, never on a resume")
	}
}
