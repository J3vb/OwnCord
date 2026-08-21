package ws

// oc_0267_voice_join_rollback_leaver_test.go — regression test for finding
// OC-0267.
//
// rollbackVoiceJoin clears the client's own voiceChID (clearVoiceAndUnsubscribe)
// and only then broadcasts the compensating voice_leave via the plain
// broadcastVoiceEvent. That helper's audience is the channel's READ audience
// unioned with clients whose *current* voiceChID still names the channel
// (hub_broadcast.go). Voice membership is gated on CONNECT_VOICE alone
// (voiceJoinPrecheck only checks permissions.ConnectVoice), so a participant
// without READ_MESSAGES on the channel is in neither audience term once their
// own voiceChID has been cleared — they never learn the join was undone.
//
// Every sibling teardown path that clears client voice state before
// broadcasting (finishVoiceLeave, webhookLeftFinishLeave,
// CleanupVoiceForChannel) uses broadcastVoiceEventWithLeaver for exactly this
// reason; rollbackVoiceJoin was the one path that used the plain helper.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

func TestRollbackVoiceJoin_BroadcastReachesLeaverWithoutReadAccess(t *testing.T) {
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "join-0267-victim")
	chID := mustCreateVoiceChannel(t, database, "voice-join-0267")

	// Deny READ_MESSAGES on this specific channel via an override, while the
	// role keeps CONNECT_VOICE (and base READ_MESSAGES elsewhere) — the exact
	// combination the finding describes: CONNECT_VOICE without READ_MESSAGES
	// on the voice channel itself.
	if err := database.UpsertChannelOverride(context.Background(), chID, harvestVoiceRoleID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "test-api-key-0267",
		LiveKitAPISecret: "test-api-secret-0267-xyz",
		LiveKitURL:       "ws://127.0.0.1:1", // never dialed: GenerateToken is local
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}

	h := NewHub(database, auth.NewRateLimiter(), nil)
	h.SetLiveKit(lk)

	send := make(chan []byte, 8)
	c := NewTestClient(h, uid, send)
	c.user = &db.User{ID: uid, Username: "join-0267-victim"}
	h.mu.Lock()
	h.clients[uid] = c
	h.mu.Unlock()

	// Fault-inject GetChannelVoiceStates inside voiceJoinComplete (same
	// technique as OC-0172's regression test) so voice_join.go:494 calls
	// rollbackVoiceJoin(..., broadcast=true) after the joiner's own
	// voice_state has already gone out and their voiceChID is set. Renaming
	// (not dropping) `users` avoids an FK-cascade delete of the voice_states
	// row masking whether the handler's own rollback is what cleaned it up.
	var hookRan bool
	voiceJoinPostTokenRaceHook = func(client *Client) {
		hookRan = true
		if _, err := database.ExecContext(context.Background(), `ALTER TABLE users RENAME TO users_bak_0267`); err != nil {
			t.Fatalf("hook: rename users: %v", err)
		}
	}
	defer func() { voiceJoinPostTokenRaceHook = nil }()

	payload, _ := json.Marshal(map[string]any{"channel_id": chID})
	h.handleVoiceJoin(context.Background(), c, json.RawMessage(payload))

	if !hookRan {
		t.Fatal("voiceJoinPostTokenRaceHook never fired — test setup is broken, not exercising the join path")
	}

	// rollbackVoiceJoin's compensating voice_leave goes out through the async
	// hub.broadcast channel (broadcastChannelScopedTo), which only reaches a
	// client's own send queue once the hub's dispatch loop (Run) is consuming
	// it. This test never starts that loop — mirrors
	// TestCleanupVoiceForChannel_ArchivedChannel_BystanderReceivesVoiceLeave in
	// hub_sweep_oc_findings_test.go — so drain h.broadcast directly and check
	// its resolved recipient list instead of the client's send channel.
	//
	// voiceJoinComplete also enqueues the joiner's own voice_state broadcast
	// for this same channelID *before* the fault fires (voice_join.go:477),
	// while c.getVoiceChID() still equals chID — so a recipient check keyed
	// only on channelID would pass from that unrelated, earlier message even
	// when the compensating voice_leave never reaches the victim. Decode each
	// queued message and match on its voice_leave payload specifically.
	var leaveRecipients []int64
drain:
	for {
		select {
		case bm := <-h.broadcast:
			if bm.channelID != chID {
				continue
			}
			var env struct {
				Type    string `json:"type"`
				Payload struct {
					ChannelID int64 `json:"channel_id"`
					UserID    int64 `json:"user_id"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(bm.msg, &env); err != nil {
				continue
			}
			if env.Type != MsgTypeVoiceLeaveBC || env.Payload.ChannelID != chID || env.Payload.UserID != uid {
				continue
			}
			leaveRecipients = bm.recipients
		default:
			break drain
		}
	}

	found := false
	for _, r := range leaveRecipients {
		if r == uid {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("victim (CONNECT_VOICE but no READ_MESSAGES on the channel) is not in the recipient list for their "+
			"own compensating voice_leave after rollbackVoiceJoin ran with broadcast=true; recipients = %v — their "+
			"client keeps the voice widget up for a room the server and every peer agree they are not in", leaveRecipients)
	}
}
