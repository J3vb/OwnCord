package ws

// event_presence_test.go — regression test for OC-0211's event.go sibling.
//
// presenceEvents is the live presence_update path (handlePresenceV2 ->
// presenceEvents), the sibling of hub_broadcast.go's BroadcastPresence for
// the connect/reconnect path. Both built the public PresenceOthersEvent
// frame with the raw customStatus passed straight through, so an invisible
// user setting a custom status live leaked the same text this whole feature
// exists to hide: every other client would see {status:"offline",
// custom_status:"<real text>"}, a combination that discloses the member is
// actually online.

import (
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// presenceEnvelope mirrors the {"type":...,"payload":{...}} shape buildJSON
// produces for a presence message.
type presenceEnvelope struct {
	Payload struct {
		Status       string  `json:"status"`
		CustomStatus *string `json:"custom_status"`
	} `json:"payload"`
}

func TestPresenceEvents_InvisibleBlanksCustomStatusForOthers(t *testing.T) {
	text := "in a meeting"
	events := presenceEvents(99, db.StatusInvisible, &text)

	var sawOthers, sawSelf bool
	for _, e := range events {
		switch ev := e.(type) {
		case PresenceOthersEvent:
			sawOthers = true
			var env presenceEnvelope
			if err := json.Unmarshal(ev.Payload(), &env); err != nil {
				t.Fatalf("unmarshal PresenceOthersEvent payload: %v", err)
			}
			if env.Payload.Status != db.StatusOffline {
				t.Errorf("PresenceOthersEvent status = %q, want %q", env.Payload.Status, db.StatusOffline)
			}
			if env.Payload.CustomStatus != nil {
				t.Errorf("PresenceOthersEvent custom_status = %v, want nil (leaked invisible user's real status text to every observer)", *env.Payload.CustomStatus)
			}
		case PresenceSelfEvent:
			sawSelf = true
			var env presenceEnvelope
			if err := json.Unmarshal(ev.Payload(), &env); err != nil {
				t.Fatalf("unmarshal PresenceSelfEvent payload: %v", err)
			}
			if env.Payload.Status != db.StatusInvisible {
				t.Errorf("PresenceSelfEvent status = %q, want %q", env.Payload.Status, db.StatusInvisible)
			}
			// The owner must still see their own real custom status.
			if env.Payload.CustomStatus == nil || *env.Payload.CustomStatus != text {
				t.Errorf("PresenceSelfEvent custom_status = %v, want %q", env.Payload.CustomStatus, text)
			}
		}
	}
	if !sawOthers {
		t.Fatal("presenceEvents did not produce a PresenceOthersEvent for an invisible status change")
	}
	if !sawSelf {
		t.Fatal("presenceEvents did not produce a PresenceSelfEvent for an invisible status change")
	}
}
