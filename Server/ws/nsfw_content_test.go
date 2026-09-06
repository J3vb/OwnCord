package ws

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestNSFW_EveryServerFrameKindIsClassified is contentBearingKinds'
// completeness guard: every server->client wire name protocol/schema.json
// registers must be listed as content or metadata, so a new frame
// (B5-8..B5-10) has to choose rather than silently defaulting to whichever
// side is more convenient.
//
// P2-9: reads the registry straight from protocol/schema.json (the same
// source api's TestAbsenceContract_NoFederationDirectoryOrListingWireTypes
// reads) instead of a hand-written list checked against its own count — a
// new protocol type lands in the schema and is classified nowhere fails
// automatically, with no fixture to remember to update.
func TestNSFW_EveryServerFrameKindIsClassified(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol", "schema.json"))
	if err != nil {
		t.Fatalf("read protocol/schema.json: %v", err)
	}
	var schema struct {
		ServerToClient []struct {
			Wire string `json:"wire"`
		} `json:"server_to_client"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("parse protocol/schema.json: %v", err)
	}
	if len(schema.ServerToClient) < 30 {
		t.Fatalf("read only %d server->client kinds from the schema; expected the full protocol (>= 30)",
			len(schema.ServerToClient))
	}

	// contentBearingKinds is keyed by wire value (MsgTypeChatMessage's
	// underlying string is "chat_message"), same as the schema's own "wire"
	// field — not the "go" constant name.
	registered := make(map[string]bool, len(schema.ServerToClient))
	for _, m := range schema.ServerToClient {
		registered[m.Wire] = true
		if _, ok := contentBearingKinds[m.Wire]; !ok {
			t.Errorf("server->client kind %q is not classified in contentBearingKinds "+
				"(ws/nsfw_content.go) — add it as content or metadata", m.Wire)
		}
	}
	// The reverse direction: nothing in the table names a kind that is not
	// actually registered, so a renamed or removed type does not leave a
	// stale, meaningless entry behind.
	for kind := range contentBearingKinds {
		if !registered[kind] {
			t.Errorf("contentBearingKinds classifies %q, which is not a registered server->client kind", kind)
		}
	}
}

// TestDeliverBroadcast_ContentFilterStillRateLimited is P2-5: a non-nil
// contentFilter must not bypass the channel's topic rate limiter — it still
// runs inside deliverBroadcast's default (topic-Publish) branch, ahead of the
// contentFilter check and the seq allocation, exactly like an unfiltered
// broadcast. Modelled on TestDeliverBroadcast_ShedFrameLeavesNoSeqGap.
func TestDeliverBroadcast_ContentFilterStillRateLimited(t *testing.T) {
	h := newEmitTestHub()
	send := make(chan []byte, 4096)
	c := NewTestClient(h, 1, send)
	h.clients[1] = c
	h.pubsub.Subscribe(c, ChannelTopic(5))

	allowAll := func(int64) bool { return true }
	total := topicRateLimitPerSecond + 20
	for range total {
		h.deliverBroadcast(broadcastMsg{channelID: 5, msg: []byte(`{"type":"chat_message"}`), contentFilter: allowAll})
	}

	delivered := 0
drain:
	for {
		select {
		case <-send:
			delivered++
		default:
			break drain
		}
	}

	if delivered != topicRateLimitPerSecond {
		t.Fatalf("delivered %d content-filtered frames out of %d sent, want exactly %d (the topic limiter) — "+
			"a contentFilter must not bypass deliverBroadcast's per-channel rate limit",
			delivered, total, topicRateLimitPerSecond)
	}
}
