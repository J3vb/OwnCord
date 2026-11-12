package ws_test

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── RefreshChannelVisibility ─────────────────────────────────────────────────

// drainForMsgType reads messages from send until one with the given type
// arrives or the timeout expires. Returns the decoded payload-bearing message.
func drainForMsgType(t *testing.T, send chan []byte, msgType string) map[string]any {
	t.Helper()
	deadline := time.After(500 * time.Millisecond)
	for {
		select {
		case raw := <-send:
			var msg map[string]any
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue
			}
			if msg["type"] == msgType {
				return msg
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q message", msgType)
			return nil
		}
	}
}

// assertNoMsgType asserts that no message of the given type is buffered.
func assertNoMsgType(t *testing.T, send chan []byte, msgType string) {
	t.Helper()
	for {
		select {
		case raw, ok := <-send:
			if !ok {
				return
			}
			var msg map[string]any
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue
			}
			if msg["type"] == msgType {
				t.Fatalf("unexpected %q message", msgType)
			}
		default:
			return
		}
	}
}

func TestRefreshChannelVisibility_TargetedSends(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	chID := seedTestChannel(t, database, "secret-room")
	ch, err := database.GetChannel(context.Background(), chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}

	owner := seedOwnerUser(t, database, "vis-owner")
	memberID := seedTestUser(t, database, "vis-member")
	member := mustGetUser(t, database, memberID)

	_, ownerSend := connectClient(t, hub, owner, chID, 16)
	_, memberSend := connectClient(t, hub, member, chID, 16)

	// Hide the channel from the Member role (deny ReadMessages).
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, 2)`,
		chID,
	); err != nil {
		t.Fatalf("insert override: %v", err)
	}

	hub.RefreshChannelVisibility(ch)

	// Member loses the channel; owner (admin bit) keeps it.
	drainForMsgType(t, memberSend, "channel_delete")
	drainForMsgType(t, ownerSend, "channel_create")

	// Restore visibility — the member gets the channel back.
	if _, err := database.ExecContext(context.Background(),
		`DELETE FROM channel_overrides WHERE channel_id = ? AND role_id = 4`, chID,
	); err != nil {
		t.Fatalf("delete override: %v", err)
	}
	hub.RefreshChannelVisibility(ch)
	drainForMsgType(t, memberSend, "channel_create")
	assertNoMsgType(t, memberSend, "channel_delete")
}

// can_send used to be computed only in the ready payload, so a mid-session
// permission edit left a connected client's composer on its stale connect-time
// verdict until the socket was rebuilt. The targeted channel_create this
// fan-out sends now carries each recipient's own verdict — and because it is
// per-recipient, two clients must be able to receive different answers from
// the same RefreshChannelVisibility call.
func TestRefreshChannelVisibility_TargetedCreateCarriesPerClientCanSend(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	chID := seedTestChannel(t, database, "cansend-room")
	ch, err := database.GetChannel(context.Background(), chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}

	owner := seedOwnerUser(t, database, "cansend-owner")
	memberID := seedTestUser(t, database, "cansend-member")
	member := mustGetUser(t, database, memberID)

	_, ownerSend := connectClient(t, hub, owner, chID, 16)
	_, memberSend := connectClient(t, hub, member, chID, 16)

	// Member keeps READ_MESSAGES (0x0002) but loses SEND_MESSAGES (0x0001), so
	// the channel stays VISIBLE while posting is revoked — precisely the case a
	// visibility-only fan-out used to leave with a stale composer.
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, 1)`,
		chID,
	); err != nil {
		t.Fatalf("insert override: %v", err)
	}

	hub.RefreshChannelVisibility(ch)

	memberMsg := drainForMsgType(t, memberSend, "channel_create")
	memberPayload, ok := memberMsg["payload"].(map[string]any)
	if !ok {
		t.Fatalf("member channel_create payload not an object: %#v", memberMsg["payload"])
	}
	canSend, present := memberPayload["can_send"]
	if !present {
		t.Fatal("targeted channel_create omitted can_send — the client keeps its stale connect-time verdict")
	}
	if canSend != false {
		t.Fatalf("member can_send = %v, want false (SEND_MESSAGES denied)", canSend)
	}

	// Same call, same channel, different recipient: the owner's admin bit must
	// still yield true, proving the value is resolved per client rather than
	// encoded once for the whole audience.
	ownerMsg := drainForMsgType(t, ownerSend, "channel_create")
	ownerPayload, ok := ownerMsg["payload"].(map[string]any)
	if !ok {
		t.Fatalf("owner channel_create payload not an object: %#v", ownerMsg["payload"])
	}
	if ownerPayload["can_send"] != true {
		t.Fatalf("owner can_send = %v, want true (admin bypass)", ownerPayload["can_send"])
	}
}

// can_move_voice (WP 8.4b) rides the targeted channel_create beside
// can_moderate_voice and is decided by its own predicate: a Moderator pinned
// to MOVE_MEMBERS without MUTE_MEMBERS moves but does not moderate, and a
// user override denying MOVE_MEMBERS flips only the move verdict.
func TestRefreshChannelVisibility_TargetedCreateCarriesCanMoveVoice(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()
	ctx := context.Background()

	chID := mustCreateChannel(t, database, "movevoice-room", "voice")
	ch, err := database.GetChannel(ctx, chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = (permissions | ?) & ? WHERE id = 3`,
		permissions.MoveMembers, ^permissions.MuteMembers); err != nil {
		t.Fatalf("pin Moderator to MOVE_MEMBERS only: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = permissions & ? WHERE id = 4`,
		^(permissions.MoveMembers | permissions.MuteMembers)); err != nil {
		t.Fatalf("strip Member move bits: %v", err)
	}
	modID := mustCreateUser(t, database, "movevoice-mod", 3)
	mod := mustGetUser(t, database, modID)
	memberID := seedTestUser(t, database, "movevoice-member")
	member := mustGetUser(t, database, memberID)
	modSend := make(chan []byte, 16)
	memberSend := make(chan []byte, 16)
	hub.Register(ws.NewTestClientWithUser(hub, mod, 0, modSend))
	memberClient := ws.NewTestClientWithUser(hub, member, 0, memberSend)
	hub.Register(memberClient)
	waitRegistered(t, hub, memberClient)

	verdicts := func(send chan []byte) (move, moderate any) {
		t.Helper()
		msg := drainForMsgType(t, send, "channel_create")
		payload, ok := msg["payload"].(map[string]any)
		if !ok {
			t.Fatalf("channel_create payload not an object: %#v", msg["payload"])
		}
		move, present := payload["can_move_voice"]
		if !present {
			t.Fatal("targeted channel_create omitted can_move_voice")
		}
		return move, payload["can_moderate_voice"]
	}
	steps := []struct {
		name string
		sql  string
		args []any
		want bool
	}{
		{"no override", "", nil, true},
		{"user deny MOVE", `INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, 0, ?)`, []any{chID, modID, permissions.MoveMembers}, false},
	}
	for _, s := range steps {
		if s.sql != "" {
			if _, err := database.ExecContext(ctx, s.sql, s.args...); err != nil {
				t.Fatalf("%s: %v", s.name, err)
			}
		}
		hub.RefreshChannelVisibility(ch)
		move, moderate := verdicts(modSend)
		if move != s.want || moderate != false {
			t.Errorf("%s: moderator can_move_voice=%v can_moderate_voice=%v, want %v and false", s.name, move, moderate, s.want)
		}
		if move, moderate := verdicts(memberSend); move != false || moderate != false {
			t.Errorf("%s: member can_move_voice=%v can_moderate_voice=%v, want false and false", s.name, move, moderate)
		}
	}
}

// can_moderate_voice (B9 Q5) rides the same targeted channel_create as
// can_send, so an override edit on either layer converges a connected
// moderator's voice controls without a reconnect — and the member, who never
// held MUTE_MEMBERS, is told false throughout.
func TestRefreshChannelVisibility_TargetedCreateCarriesCanModerateVoice(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()
	ctx := context.Background()

	chID := mustCreateChannel(t, database, "modvoice-room", "voice")
	ch, err := database.GetChannel(ctx, chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}

	// Pin the Moderator role's MUTE_MEMBERS rather than lean on migration
	// history for the default mask.
	mustExec(t, database, `UPDATE roles SET permissions = permissions | ? WHERE id = 3`, permissions.MuteMembers)
	modID := mustCreateUser(t, database, "modvoice-mod", 3)
	mod := mustGetUser(t, database, modID)
	memberID := seedTestUser(t, database, "modvoice-member")
	member := mustGetUser(t, database, memberID)

	_, modSend := connectClient(t, hub, mod, 0, 16)
	_, memberSend := connectClient(t, hub, member, 0, 16)

	canModerateVoice := func(send chan []byte) any {
		t.Helper()
		msg := drainForMsgType(t, send, "channel_create")
		payload, ok := msg["payload"].(map[string]any)
		if !ok {
			t.Fatalf("channel_create payload not an object: %#v", msg["payload"])
		}
		v, present := payload["can_moderate_voice"]
		if !present {
			t.Fatal("targeted channel_create omitted can_moderate_voice")
		}
		return v
	}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := database.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	mute := permissions.MuteMembers

	steps := []struct {
		name          string
		sql           string
		args          []any
		wantMod       bool
		wantMemberMod bool
	}{
		{"no override", "", nil, true, false},
		{"role deny MUTE", `INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 3, 0, ?)`, []any{chID, mute}, false, false},
		{"role deny lifted", `DELETE FROM channel_overrides WHERE channel_id = ? AND role_id = 3`, []any{chID}, true, false},
		{"user deny MUTE", `INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, 0, ?)`, []any{chID, modID, mute}, false, false},
		// A channel allow cannot manufacture authority the base role lacks.
		{"member user allow MUTE", `INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, ?, 0)`, []any{chID, memberID, mute}, false, false},
	}
	for _, s := range steps {
		if s.sql != "" {
			exec(s.sql, s.args...)
		}
		hub.RefreshChannelVisibility(ch)
		if got := canModerateVoice(modSend); got != s.wantMod {
			t.Errorf("%s: moderator can_moderate_voice = %v, want %v", s.name, got, s.wantMod)
		}
		if got := canModerateVoice(memberSend); got != s.wantMemberMod {
			t.Errorf("%s: member can_moderate_voice = %v, want %v", s.name, got, s.wantMemberMod)
		}
	}
}

// A newly created channel has no earlier verdict for an absent field to keep,
// so the creation fan-out must carry each recipient's own can_moderate_voice.
func TestBroadcastChannelCreate_CarriesPerRecipientCanModerateVoice(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()
	ctx := context.Background()

	mustExec(t, database, `UPDATE roles SET permissions = permissions | ? WHERE id = 3`, permissions.MuteMembers)
	modID := mustCreateUser(t, database, "newvoice-mod", 3)
	mod := mustGetUser(t, database, modID)
	memberID := seedTestUser(t, database, "newvoice-member")
	member := mustGetUser(t, database, memberID)

	modSend := make(chan []byte, 16)
	memberSend := make(chan []byte, 16)
	hub.Register(ws.NewTestClientWithUser(hub, mod, 0, modSend))
	memberClient := ws.NewTestClientWithUser(hub, member, 0, memberSend)
	hub.Register(memberClient)
	waitRegistered(t, hub, memberClient)

	chID := mustCreateChannel(t, database, "newvoice-room", "voice")
	ch, err := database.GetChannel(ctx, chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	hub.BroadcastChannelCreate(ch)

	for _, tc := range []struct {
		name string
		send chan []byte
		want bool
	}{
		{"moderator", modSend, true},
		{"member", memberSend, false},
	} {
		msg := drainForMsgType(t, tc.send, "channel_create")
		payload, ok := msg["payload"].(map[string]any)
		if !ok {
			t.Fatalf("%s: channel_create payload not an object: %#v", tc.name, msg["payload"])
		}
		if id, _ := payload["id"].(float64); int64(id) != chID {
			t.Fatalf("%s: channel_create id = %v, want %d", tc.name, payload["id"], chID)
		}
		v, present := payload["can_moderate_voice"]
		if !present {
			t.Fatalf("%s: channel_create for a new channel omitted can_moderate_voice", tc.name)
		}
		if v != tc.want {
			t.Errorf("%s: can_moderate_voice = %v, want %v", tc.name, v, tc.want)
		}
		if v, present := payload["can_send"]; !present || v != true {
			t.Errorf("%s: can_send = %v (present %v), want true", tc.name, v, present)
		}
	}
}

func TestRefreshChannelVisibility_ForcesFullResyncForStaleResumes(t *testing.T) {
	hub, database := newTestHub(t)

	chID := seedTestChannel(t, database, "watermark-room")
	ch, err := database.GetChannel(context.Background(), chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}

	// No visibility change yet — resume is allowed regardless of seq.
	if hub.MustFullResyncForTest(1) {
		t.Error("expected replay allowed before any visibility change")
	}

	hub.SeedSeq(41)
	hub.RefreshChannelVisibility(ch)

	// Clients resuming from at/before the change must take the full path.
	if !hub.MustFullResyncForTest(41) {
		t.Error("expected forced full resync for lastSeq at the watermark")
	}
	if !hub.MustFullResyncForTest(10) {
		t.Error("expected forced full resync for lastSeq before the watermark")
	}
	// Clients that saw sequenced traffic after the change may replay.
	if hub.MustFullResyncForTest(42) {
		t.Error("expected replay allowed for lastSeq after the watermark")
	}
}

// ─── BroadcastMemberUpdate (role reassignment) ────────────────────────────────

// A role change must drop the live channel topics the new role cannot READ —
// the subscription is created once, at channel_focus, and otherwise outlives
// the authorization it was granted under. DM topics are membership-gated, not
// role-gated, so they must survive.
func TestBroadcastMemberUpdate_RevokesUnreadableSubscriptions(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()
	ctx := context.Background()

	chID := seedTestChannel(t, database, "role-room")
	dmID, err := database.CreateChannel(ctx, "dm-room", "dm", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(dm): %v", err)
	}

	// Connect as Owner (reads everything) with the text channel focused.
	user := seedOwnerUser(t, database, "demote-me")
	if _, err := database.ExecContext(ctx,
		`INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?)`, dmID, user.ID,
	); err != nil {
		t.Fatalf("insert dm_participants: %v", err)
	}
	c, send := connectClient(t, hub, user, chID, 16)
	// The user is a participant of this DM but has closed it (no dm_open_state
	// row), so the topic is held while being absent from the allowed set.
	hub.PubSubForTest().Subscribe(c, ws.ChannelTopic(dmID))

	// Demote to Member, with READ_MESSAGES denied to that role on the channel.
	if _, err := database.ExecContext(ctx,
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, 2)`, chID,
	); err != nil {
		t.Fatalf("insert override: %v", err)
	}
	if err := database.UpdateUserRole(ctx, user.ID, 4); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}

	hub.SeedSeq(41)
	hub.BroadcastMemberUpdate(user.ID, "member")

	msg := drainForMsgType(t, send, "channel_delete")
	payload, _ := msg["payload"].(map[string]any)
	id, _ := payload["id"].(float64)
	if int64(id) != chID {
		t.Errorf("channel_delete id = %v, want %d", payload["id"], chID)
	}

	// The socket stays up; only the unreadable topic is gone.
	if got := hub.ClientCount(); got != 1 {
		t.Fatalf("ClientCount = %d, want 1 (socket must stay up)", got)
	}
	topics := hub.PubSubForTest().TopicsForUser(user.ID)
	if slices.Contains(topics, ws.ChannelTopic(chID)) {
		t.Error("still subscribed to the revoked channel topic")
	}
	if !slices.Contains(topics, ws.ChannelTopic(dmID)) {
		t.Error("DM topic revoked by a role change (DM access is membership-gated)")
	}

	// The impact itself: channel traffic no longer reaches the demoted socket.
	// Absence assertion: bounded window for a wrongly-delivered message to
	// arrive before checking the buffer.
	hub.BroadcastToChannel(chID, []byte(`{"type":"chat_message"}`))
	time.Sleep(30 * time.Millisecond)
	assertNoMsgType(t, send, "chat_message")

	// A resume across the change must take the full-ready path.
	if !hub.MustFullResyncForTest(41) {
		t.Error("expected forced full resync for a resume at the change watermark")
	}
}

// When the new visibility cannot be resolved (DB hiccup), the socket is closed
// rather than left half-revoked: the client reconnects and rebuilds from a
// ready payload computed with the new role.
func TestBroadcastMemberUpdate_ClosesSocketWhenVisibilityUnresolved(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	chID := seedTestChannel(t, database, "hiccup-room")
	uid := seedTestUser(t, database, "hiccup-user")
	user := mustGetUser(t, database, uid)
	connectClient(t, hub, user, chID, 16)

	// Break the override lookup computeAllowedChannels depends on.
	mustExec(t, database, `DROP TABLE channel_overrides`)

	hub.BroadcastMemberUpdate(uid, "member")

	if got := hub.ClientCount(); got != 0 {
		t.Errorf("ClientCount = %d, want 0 (socket must close when visibility is unresolved)", got)
	}
	if topics := hub.PubSubForTest().TopicsForUser(uid); len(topics) != 0 {
		t.Errorf("TopicsForClient = %v, want none", topics)
	}
}
