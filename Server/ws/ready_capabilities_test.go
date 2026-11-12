package ws

import (
	"encoding/json"
	"testing"
)

// The server resolves <@id> and <@&id> tokens on every send, so the flag that tells a client to
// send picked mentions as tokens is always on.
func TestReadyCapabilities_AdvertiseIDMentions(t *testing.T) {
	t.Parallel()
	raw, err := json.Marshal(readyCapabilities(0, false, false, false))
	if err != nil {
		t.Fatalf("marshal capabilities: %v", err)
	}
	var caps map[string]any
	if err := json.Unmarshal(raw, &caps); err != nil {
		t.Fatalf("unmarshal capabilities: %v", err)
	}
	if caps["id_mentions"] != true {
		t.Errorf("capabilities.id_mentions = %v, want true", caps["id_mentions"])
	}
}
