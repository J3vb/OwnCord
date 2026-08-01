package ws_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/owncord/server/permissions"
	"github.com/owncord/server/ws"
)

// ─── mark_read ──────────────────────────────────────────────────────────────
//
// mark_read exists because channel_focus conflates two things: "this is the
// channel I am looking at" and "I have read this channel". Marking a *different*
// channel read from its context menu must do the second without the first.

func markReadEnvelope(channelID int64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "mark_read",
		"payload": map[string]any{"channel_id": channelID},
	})
	return raw
}

func TestMarkRead_AdvancesReadStateWithoutChangingFocus(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "markread-user")
	focused := seedTestChannel(t, database, "markread-focused")
	other := seedTestChannel(t, database, "markread-other")

	latest, err := database.CreateMessage(context.Background(), other, user.ID, "unread", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, focused, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, markReadEnvelope(other))

	if code := drainForErrorCode(send, 100*time.Millisecond); code != "" {
		t.Fatalf("unexpected error code %q for a valid mark_read", code)
	}

	// The read state for the *other* channel advanced …
	counts, err := database.GetChannelUnreadCounts(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts: %v", err)
	}
	if cu := counts[other]; cu.UnreadCount != 0 {
		t.Errorf("unread for marked channel = %d, want 0", cu.UnreadCount)
	}
	if cu := counts[other]; cu.LastMessageID != latest {
		t.Errorf("last message id = %d, want %d", cu.LastMessageID, latest)
	}

	// … while the connection still points at the channel the user is viewing.
	if got := ws.ClientChannelIDForTest(c); got != focused {
		t.Errorf("focused channel = %d, want %d (mark_read must not move focus)", got, focused)
	}
}

// mark_read clears the mention badge too — read_states.mention_count is zeroed
// by UpdateReadState, which is what makes "Mark as Read" clear a red badge.
func TestMarkRead_ClearsMentionCount(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "markread-mention-user")
	chID := seedTestChannel(t, database, "markread-mention-chan")
	if _, err := database.CreateMessage(context.Background(), chID, user.ID, "@you", nil); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if err := database.IncrementMentionCounts(context.Background(), chID, []int64{user.ID}); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, markReadEnvelope(chID))

	counts, err := database.GetChannelUnreadCounts(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts: %v", err)
	}
	if cu := counts[chID]; cu.MentionCount != 0 {
		t.Errorf("mention count = %d, want 0", cu.MentionCount)
	}
}

func TestMarkRead_DeniedChannelIsForbidden(t *testing.T) {
	hub, database := newHandlerHub(t)
	chID := seedTestChannel(t, database, "markread-denied-chan")
	user := seedMemberUser(t, database, "markread-denied-user")
	denyReadOnChannel(t, database, chID, permissions.MemberRoleID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, markReadEnvelope(chID))

	if code := drainForErrorCode(send, 300*time.Millisecond); code != "FORBIDDEN" {
		t.Errorf("error code = %q, want FORBIDDEN", code)
	}
}

func TestMarkRead_RejectsInvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "markread-badpayload-user")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, markReadEnvelope(0))

	if code := drainForErrorCode(send, 300*time.Millisecond); code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for channel_id 0", code)
	}
}
