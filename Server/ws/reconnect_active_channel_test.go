package ws

// reconnect_active_channel_test.go — regression test for finding v019.
//
// registerNow restores a resuming client's ChannelTopic subscription by
// copying it from the OLD client entry. But readPump's unregister deletes that
// entry as soon as the server observes the socket close, which normally
// happens well before the client's first reconnect attempt — so on the common
// resume there is nothing to copy from, and the reconnected socket holds NO
// channel subscription until its post-auth_ok channel_focus round trip lands.
// Every message broadcast to that channel in the window (auth_ok write, up to
// maxColdReplay replay frames, pump startup, one RTT) is delivered to nobody
// and can never be re-requested, because the client only reports max(seq).
//
// The auth frame now carries active_channel_id, which handleReconnect promotes
// to c.channelID — READ-gated — before registerNow runs.

import (
	"context"
	"testing"
	"time"
)

func TestReconnect_AuthFrameActiveChannelRestoresSubscription(t *testing.T) {
	rig := newServeRig(t)
	hub := rig.hub
	ctx := context.Background()
	user, token := rig.seedOwner(t, "resume-focus-user")
	chID := mustCreateTextChannel(t, rig.db, "resume-room")

	// Precondition: the channel IS readable, so the auth-frame id is eligible
	// to be honoured (an unreadable one must be ignored — covered below).
	allowed, err := hub.computeAllowedChannels(ctx, rig.db, user)
	if err != nil {
		t.Fatalf("computeAllowedChannels: %v", err)
	}
	if !allowed[chID] {
		t.Fatalf("precondition: channel %d should be READ-visible", chID)
	}

	// Deliberately NO pre-registered old client: this is the exact case the
	// subscription-transfer path cannot cover, because there is nothing to
	// copy the focused channel from.
	// EventsSinceFiltered returns nil unless last_seq is STRICTLY greater than
	// the oldest buffered seq and no greater than the newest, so the window has
	// to bracket it: 98 anchors below, 100 sits above. Without that the replay
	// is empty, handleReconnect returns false, and the connection falls through
	// to the full-ready path -- which also sends auth_ok, so asserting on that
	// frame alone would not distinguish the two.
	rb := hub.ReplayBuffer()
	rb.Push(98, chID, []byte(`{"seq":98,"type":"chat_message","payload":{}}`))
	rb.Push(99, chID, []byte(`{"seq":99,"type":"chat_message","payload":{}}`))
	rb.Push(100, chID, []byte(`{"seq":100,"type":"chat_message","payload":{}}`))

	conn := rig.dialAuth(t, ctx, token, 99, chID)
	if typ, _ := readFrameType(t, ctx, conn); typ != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok (buffer-tier resume), got %v", typ)
	}

	// The registered client must already be focused on — and subscribed to —
	// the channel, with no channel_focus ever sent.
	if _, got, ok := rig.waitFocused(user.ID, chID); !ok {
		t.Fatalf("resumed client channelID = %d, want %d — the socket is unsubscribed until channel_focus, "+
			"so every broadcast to that channel in the meantime is lost", got, chID)
	}
}

// The id is attacker-controlled, so a channel the user may not read must never
// be honoured — it would hand out a ChannelTopic subscription (and with it the
// channel's live message stream) that the permission set denies.
func TestReconnect_AuthFrameActiveChannelIsReadGated(t *testing.T) {
	rig := newServeRig(t)
	hub := rig.hub
	ctx := context.Background()
	user, token := rig.seedOwner(t, "resume-gated-user")
	noPerms, err := rig.db.CreateRole(ctx, "no-perms-resume", nil, 0, 1, false, false)
	if err != nil || noPerms == nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if err := rig.db.UpdateUserRole(ctx, user.ID, noPerms.ID); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	user, err = rig.db.GetUserByID(ctx, user.ID)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	secretID := mustCreateTextChannel(t, rig.db, "secret-resume")

	allowed, err := hub.computeAllowedChannels(ctx, rig.db, user)
	if err != nil {
		t.Fatalf("computeAllowedChannels: %v", err)
	}
	if allowed[secretID] {
		t.Fatalf("precondition: channel %d must NOT be readable by this role", secretID)
	}

	// Global (channel_id 0) frames bracketing last_seq, so the resume takes the
	// buffer tier rather than falling through to full ready.
	hub.ReplayBuffer().Push(98, 0, []byte(`{"seq":98,"type":"presence","payload":{}}`))
	hub.ReplayBuffer().Push(99, 0, []byte(`{"seq":99,"type":"presence","payload":{}}`))
	hub.ReplayBuffer().Push(100, 0, []byte(`{"seq":100,"type":"presence","payload":{}}`))

	conn := rig.dialAuth(t, ctx, token, 99, secretID)
	readFrameType(t, ctx, conn)

	// Give registration a moment, then assert the claim was refused.
	time.Sleep(200 * time.Millisecond)
	c := rig.newestClient(user.ID)
	if c == nil {
		t.Fatal("client was not registered")
	}
	if got := c.getChannelID(); got == secretID {
		t.Fatalf("client was focused on unreadable channel %d from an attacker-supplied auth frame", got)
	}
}
