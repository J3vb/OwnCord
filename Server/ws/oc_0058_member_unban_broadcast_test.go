package ws_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/ws"
)

// OC-0058: the admin unban path type-asserts its hub against an optional
// BroadcastMemberUnban capability, but *ws.Hub never implemented it — the
// assertion always missed, so clients connected during the ban (which
// hard-deleted the member row on member_ban) never learned the user was
// back, permanently disagreeing with freshly connecting clients. The hub
// must implement the mirror of BroadcastMemberBan: a member_join fan-out
// that re-adds the user to every connected member store. The unbanned user
// has no live connection (the ban kicked them), so the payload must report
// them offline regardless of the stale status their row carries.
func TestBroadcastMemberUnban_FansOutMemberJoin(t *testing.T) {
	hub, database := newVoiceHub(t)
	alice := seedMemberUser(t, database, "unban-alice")
	bob := seedMemberUser(t, database, "unban-bob")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, bob, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)
	drainChanTimeout(send, 100*time.Millisecond)

	hub.BroadcastMemberUnban(alice.ID)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	for _, m := range msgs {
		if extractType(t, m) != "member_join" {
			continue
		}
		var parsed struct {
			Payload struct {
				User struct {
					ID       int64  `json:"id"`
					Username string `json:"username"`
				} `json:"user"`
				Status string `json:"status"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(m, &parsed); err != nil {
			t.Fatalf("unmarshal member_join: %v", err)
		}
		if parsed.Payload.User.ID != alice.ID {
			t.Fatalf("member_join user id = %d, want %d", parsed.Payload.User.ID, alice.ID)
		}
		if parsed.Payload.User.Username != alice.Username {
			t.Fatalf("member_join username = %q, want %q", parsed.Payload.User.Username, alice.Username)
		}
		if parsed.Payload.Status != "offline" {
			t.Fatalf("member_join status = %q, want offline — the unbanned user cannot be connected", parsed.Payload.Status)
		}
		return
	}
	t.Fatal("no member_join reached a connected client after BroadcastMemberUnban")
}
