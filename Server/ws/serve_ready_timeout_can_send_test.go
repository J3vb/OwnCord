package ws_test

// serve_ready_timeout_can_send_test.go — regression test for finding
// OC-0434: channelCanSend builds its permissions.Subject from RolePerms,
// Override and Channel.Type alone, leaving Subject.TimedOut at its zero
// value. permissions.CanSendMessage's very first check is
// `if s.TimedOut { return ErrTimedOut }`, so a user with an active timeout
// (a moderation_actions row, kind='timeout', not yet expired/lifted) got
// can_send: true on every visible text/announcement channel in their
// fresh-connect ready payload -- identical to refreshChannelVisibilityCanSend
// (the live-refresh sibling on a targeted channel_create), which DOES thread
// a live HasActiveTimeout lookup through subjectFor. The very next send from
// that client is refused with TIMED_OUT even though the composer was left
// enabled.

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestBuildReady_TimedOutUserCanSendFalse(t *testing.T) {
	hub, database := newServeHub(t)
	ctx := context.Background()

	// Actor: role 1 (Owner, position 100) -- outranks the Member target
	// below (role 4, position 40), as recordModerationAction's rank check
	// (db.TimeoutUser) requires.
	actor := seedServeUser(t, database, "timeout-actor")

	targetID, err := database.CreateUser(ctx, "timeout-target", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(target): %v", err)
	}
	memberRole, err := database.GetRoleByID(ctx, 4)
	if err != nil || memberRole == nil {
		t.Fatalf("GetRoleByID(member): %v", err)
	}

	if _, err := database.CreateChannel(ctx, "general", "text", "", "", 0); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	// Apply an active timeout to the target, mirroring a moderator's live
	// action. users.banned is untouched -- the handshake itself is never
	// refused; only the send predicate must see it.
	if _, _, err := database.TimeoutUser(ctx, targetID, actor.ID, nil, "spam", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}

	msg, err := hub.BuildReadyWithRoleForTest(database, targetID, memberRole)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}

	var env struct {
		Payload struct {
			Channels []struct {
				Name    string `json:"name"`
				Type    string `json:"type"`
				CanSend bool   `json:"can_send"`
			} `json:"channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	sawTextChannel := false
	for _, ch := range env.Payload.Channels {
		if ch.Type != "text" {
			continue
		}
		sawTextChannel = true
		if ch.CanSend {
			t.Errorf("channel %q: can_send = true for a user with an active timeout, want false", ch.Name)
		}
	}
	if !sawTextChannel {
		t.Fatal("expected at least one text channel in the ready payload")
	}
}
