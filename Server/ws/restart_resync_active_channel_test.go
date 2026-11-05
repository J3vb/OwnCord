package ws

// restart_resync_active_channel_test.go — regression test for the restart
// load profile's ws_replay_gap gate.
//
// A server restart renumbers the seq space from a fresh per-boot floor
// (OC-0210) and bumps the visibility watermark, so EVERY resume after a
// restart is forced onto the full-resync path (replay_source "none"). The
// auth frame's active_channel_id was honoured only along handleReconnect's
// replay-capable path; handleFreshConnect ignored it, so the full-resync
// socket held no ChannelTopic subscription until its post-ready
// channel_focus round trip landed. Every channel frame broadcast in that
// window (auth_ok + ready write, pump startup, one RTT) reached nobody on
// that socket and could never be re-requested, because the client only
// reports max(seq). Under the restart drill all 100 connections reconnect at
// once and keep chatting, so those windows overlap and frames are lost —
// which is exactly the ws_replay_gap max==0 gate failing 2/2.

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestFullResyncAfterRestartHonorsActiveChannelID(t *testing.T) {
	rig := newServeRig(t)
	hub := rig.hub
	ctx := context.Background()
	user, token := rig.seedOwner(t, "restart-resync-user")
	chID := mustCreateTextChannel(t, rig.db, "restart-resync-room")

	// Precondition: the channel IS readable, so the auth-frame id is eligible
	// to be honoured.
	allowed, err := hub.computeAllowedChannels(ctx, rig.db, user)
	if err != nil {
		t.Fatalf("computeAllowedChannels: %v", err)
	}
	if !allowed[chID] {
		t.Fatalf("precondition: channel %d should be READ-visible", chID)
	}

	// Simulate the post-restart boot: seedHubReplayState reserves a fresh seq
	// floor far above any pre-restart value and bumps the visibility watermark
	// (internal/app/persistence.go), forcing every resume onto the full-resync
	// path.
	hub.SeedSeq(1_000_000_000)
	hub.MarkVisibilityChanged()
	const preRestartLastSeq = 500
	if !hub.mustFullResync(preRestartLastSeq) {
		t.Fatalf("precondition: mustFullResync must be true after the simulated restart boot")
	}

	conn := rig.dialAuth(t, ctx, token, preRestartLastSeq, chID)

	// auth_ok carries replay_source "none" — proof this is the full-resync path.
	typ, authMsg := readFrameType(t, ctx, conn)
	if typ != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok, got %v", typ)
	}
	var authParsed struct {
		Payload map[string]any `json:"payload"`
	}
	if err := json.Unmarshal(authMsg, &authParsed); err != nil {
		t.Fatalf("unmarshal auth_ok: %v", err)
	}
	if authParsed.Payload["replay_source"] != "none" {
		t.Fatalf("expected replay_source=none (full resync), got %v", authParsed.Payload["replay_source"])
	}
	if typ, _ := readFrameType(t, ctx, conn); typ != MsgTypeReady {
		t.Fatalf("expected ready, got %v", typ)
	}

	// The full-resync socket must already be focused on — and subscribed to —
	// the channel the auth frame named, BEFORE any channel_focus is sent.
	if _, got, ok := rig.waitFocused(user.ID, chID); !ok {
		t.Fatalf("post-restart full-resync client channelID = %d, want %d — the auth frame's "+
			"active_channel_id was ignored on the full-resync path, so the socket is unsubscribed "+
			"until channel_focus and every channel frame broadcast in the meantime is lost", got, chID)
	}

	// End-to-end: a channel frame broadcast right now (before the client sends
	// its own channel_focus) must reach this socket. Without the subscription
	// it is delivered to nobody and cannot be requested back.
	hub.BroadcastToChannel(chID, []byte(`{"type":"chat_message","payload":{"channel_id":1,"content":"restart-resync-probe"}}`))

	probeDeadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(probeDeadline) {
		frameCtx, frameCancel := context.WithTimeout(ctx, time.Until(probeDeadline))
		_, frame, frameErr := conn.Read(frameCtx)
		frameCancel()
		if frameErr != nil {
			break
		}
		var frameParsed map[string]any
		if err := json.Unmarshal(frame, &frameParsed); err != nil {
			continue
		}
		if frameParsed["type"] != MsgTypeChatMessage {
			continue
		}
		payload, _ := frameParsed["payload"].(map[string]any)
		if payload["content"] == "restart-resync-probe" {
			return
		}
	}
	t.Fatalf("post-restart full-resync socket never received the channel frame broadcast during its "+
		"resume handshake (channel %d) — the frame is lost, which is the ws_replay_gap the restart "+
		"load profile gates on", chID)
}

// The auth frame's id is attacker-controlled, so on the full-resync path too it
// must be honoured only when the freshly recomputed READ set contains it — the
// same fail-closed gate handleReconnect applies. A regression here would hand
// an unreadable channel's live stream to a resumed socket.
func TestFullResyncAfterRestartActiveChannelIsReadGated(t *testing.T) {
	rig := newServeRig(t)
	hub := rig.hub
	ctx := context.Background()
	user, token := rig.seedOwner(t, "restart-resync-gated")
	noPerms, err := rig.db.CreateRole(ctx, "restart-resync-no-perms", nil, 0, 1, false, false)
	if err != nil || noPerms == nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if err := rig.db.UpdateUserRole(ctx, user.ID, noPerms.ID); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	secretID := mustCreateTextChannel(t, rig.db, "restart-resync-secret")

	hub.SeedSeq(1_000_000_000)
	hub.MarkVisibilityChanged()

	rig.handshake(t, ctx, token, 500, secretID)

	time.Sleep(200 * time.Millisecond)
	c := rig.newestClient(user.ID)
	if c == nil {
		t.Fatal("client was not registered")
	}
	if got := c.getChannelID(); got == secretID {
		t.Fatalf("post-restart full-resync client was focused on unreadable channel %d from an "+
			"attacker-supplied auth frame", got)
	}
	sub := hub.pubsub.subscriberForTest(ChannelTopic(secretID), user.ID)
	if sub != nil {
		t.Fatalf("post-restart full-resync client is subscribed to ChannelTopic(%d) despite "+
			"READ_MESSAGES being denied", secretID)
	}
}

// A fresh connect (last_seq == 0) is not a resume, so docs/protocol.md says the
// hint is ignored there: the socket must stay unsubscribed until its own
// channel_focus, even when the named channel is READ-visible.
func TestFreshConnectIgnoresActiveChannelID(t *testing.T) {
	rig := newServeRig(t)
	ctx := context.Background()
	user, token := rig.seedOwner(t, "fresh-connect-hint-user")
	chID := mustCreateTextChannel(t, rig.db, "fresh-connect-hint-room")

	rig.handshake(t, ctx, token, 0, chID)

	time.Sleep(200 * time.Millisecond)
	c := rig.newestClient(user.ID)
	if c == nil {
		t.Fatal("client was not registered")
	}
	if got := c.getChannelID(); got != 0 {
		t.Fatalf("fresh-connect client channelID = %d, want 0 — active_channel_id must be "+
			"ignored when last_seq is 0", got)
	}
	sub := rig.hub.pubsub.subscriberForTest(ChannelTopic(chID), user.ID)
	if sub != nil {
		t.Fatalf("fresh-connect client is subscribed to ChannelTopic(%d) via the auth-frame hint", chID)
	}
}
