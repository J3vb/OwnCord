package ws

// oc_0316_voice_e2ee_resume_rotation_test.go — regression test for finding
// OC-0316.
//
// registerNow's resume-time E2EE resync (OC-0276, sendVoicePeerKeys) only
// pushes OTHER participants' stored ECDH public keys TO the resuming client.
// It never re-relays the resuming client's OWN key back onto the voice
// channel. voice_e2ee_offer (the room-key-bearing message) is a targeted,
// unsequenced send (sendToUserIfInVoiceChannel) that is silently dropped if
// the target's socket is down — so a key rotation that lands while a
// participant's WebSocket is blipped is lost forever, and no reconnect
// replay tier (buffer or DB) can recover it, because the offer never gets a
// seq.
//
// The client's duplicate-announce handling (handleAnnounceInner) already
// re-wraps and re-offers the CURRENT room key whenever it sees an announce
// carrying a peer's already-known key — that path exists for exactly this
// recovery, but nothing on the server ever triggers it after a resume. This
// test pins that the server closes the loop: on a resumed connection that is
// still in a voice channel, registerNow must re-broadcast the resuming
// client's own stored key onto VoiceTopic (excluding itself) so the key
// holder's duplicate-announce branch fires and re-offers the live room key.
import (
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestRegisterNow_ReannouncesOwnKeyOnResume(t *testing.T) {
	database := newTeardownTestDB(t)
	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)

	const (
		chanID = int64(500)
		peerID = int64(1) // the key holder (lower user id)
		userID = int64(2) // the resuming client
	)

	// Peer (the key holder) is already connected and in the voice channel,
	// subscribed to VoiceTopic like any real voice participant.
	peerSend := make(chan []byte, 8)
	peer := &Client{userID: peerID, send: peerSend, sendHigh: peerSend, sendLow: peerSend}
	peer.voiceChID = chanID
	peer.e2eePubKey = "peer-pub-key-b64"
	hub.mu.Lock()
	hub.clients[peerID] = peer
	hub.mu.Unlock()
	hub.pubsub.Subscribe(peer, VoiceTopic(chanID))

	// userID's PREVIOUS connection, still registered, with a completed voice
	// join and a stored E2EE key — exactly what registerNow transfers onto a
	// resuming connection per OC-0270.
	oldSend := make(chan []byte, 8)
	old := &Client{userID: userID, send: oldSend, sendHigh: oldSend, sendLow: oldSend}
	old.voiceChID = chanID
	old.voiceJoinToken = "join-token"
	old.voiceJoinCompleted = true
	old.e2eePubKey = "user-pub-key-b64"
	old.e2eeSignature = "user-sig"
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

	close(peerSend)
	var gotReannounce bool
	for msg := range peerSend {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				UserID    int64  `json:"user_id"`
				PublicKey string `json:"public_key"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatalf("unmarshal message sent to peer: %v (raw=%s)", err, msg)
		}
		if env.Type == MsgTypeVoiceE2EEAnnounceBC && env.Payload.UserID == userID && env.Payload.PublicKey == "user-pub-key-b64" {
			gotReannounce = true
		}
	}
	if !gotReannounce {
		t.Error("resumed client's own E2EE key was never re-broadcast onto the voice channel — " +
			"OC-0316: the key holder never re-offers the room key after a peer's WS-only resume, " +
			"so a rotation that lands during the outage strands the resumed client on a dead key")
	}
}
