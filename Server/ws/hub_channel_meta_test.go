package ws_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/ws"
)

// countChannelMetaFor counts channel_create / channel_update events for a
// specific channel id in a batch of raw WS frames.
func countChannelMetaFor(msgs [][]byte, channelID int64) int {
	n := 0
	for _, m := range msgs {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				ID int64 `json:"id"`
			} `json:"payload"`
		}
		if json.Unmarshal(m, &env) != nil {
			continue
		}
		if env.Payload.ID != channelID {
			continue
		}
		if env.Type == "channel_create" || env.Type == "channel_update" {
			n++
		}
	}
	return n
}

// TestChannelMetadata_NotDeliveredToRolesDeniedRead locks the visibility
// invariant for channel metadata: channel_create / channel_update used to go
// out via BroadcastToAll, so every authenticated client learned the name,
// category and topic of a channel that channel_overrides hides from their role —
// live, and again on reconnect, since an event stored under channelID 0 is
// replayed unconditionally. A role that may READ the channel must still receive
// both, live and on replay.
func TestChannelMetadata_NotDeliveredToRolesDeniedRead(t *testing.T) {
	hub, database := newHandlerHub(t)

	pubID := seedTestChannel(t, database, "chmeta-general")
	privID := seedTestChannel(t, database, "chmeta-leadership")

	insider := seedMemberUser(t, database, "chmeta-insider") // role 4: base READ_MESSAGES
	outsider := seedModUser(t, database, "chmeta-outsider")  // role 3: denied READ below
	if err := database.UpsertChannelOverride(
		context.Background(), privID, outsider.RoleID, 0, permissions.ReadMessages,
	); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	insiderSend := make(chan []byte, 64)
	outsiderSend := make(chan []byte, 64)
	cOutsider := ws.NewTestClientWithUser(hub, outsider, 0, outsiderSend)
	hub.Register(ws.NewTestClientWithUser(hub, insider, 0, insiderSend))
	hub.Register(cOutsider)
	waitRegistered(t, hub, cOutsider) // in-order events: both clients registered

	pub := &db.Channel{ID: pubID, Name: "chmeta-general", Type: "text", Category: "Text"}
	priv := &db.Channel{
		ID: privID, Name: "chmeta-leadership", Type: "text",
		Category: "Staff", Topic: "acquisition talks",
	}
	hub.BroadcastChannelCreate(pub)
	hub.BroadcastChannelUpdate(pub)
	hub.BroadcastChannelCreate(priv)
	hub.BroadcastChannelUpdate(priv)

	// ── live delivery ─────────────────────────────────────────────────────────
	insiderLive := drainChanTimeout(insiderSend, 200*time.Millisecond)
	outsiderLive := drainChanTimeout(outsiderSend, 200*time.Millisecond)

	if got := countChannelMetaFor(insiderLive, privID); got != 2 {
		t.Errorf("insider received %d channel_create/channel_update for the private channel, want 2", got)
	}
	// Positive control: the outsider is connected and receiving, so a zero count
	// on the private channel is filtering and not a broken delivery path.
	if got := countChannelMetaFor(outsiderLive, pubID); got != 2 {
		t.Errorf("outsider received %d channel_create/channel_update for the readable channel, want 2", got)
	}
	if got := countChannelMetaFor(outsiderLive, privID); got != 0 {
		t.Errorf("a role denied READ received %d channel metadata events for the private channel, want 0", got)
	}

	// ── reconnect replay ──────────────────────────────────────────────────────
	oldest := hub.ReplayBuffer().OldestSeq()
	if oldest == 0 {
		t.Fatal("replay buffer recorded no channel events (oldest seq is 0)")
	}
	replayFor := func(u *db.User) [][]byte {
		t.Helper()
		allowed, err := hub.ComputeAllowedChannelsForTest(database, u)
		if err != nil {
			t.Fatalf("ComputeAllowedChannelsForTest: %v", err)
		}
		return hub.ReplayBuffer().EventsSinceFiltered(oldest+1, allowed)
	}

	if got := countChannelMetaFor(replayFor(insider), privID); got != 2 {
		t.Errorf("insider replay contained %d channel metadata events for the private channel, want 2", got)
	}
	if got := countChannelMetaFor(replayFor(outsider), privID); got != 0 {
		t.Errorf("replay leaked %d channel metadata events for the private channel to a role denied READ, want 0", got)
	}
}
