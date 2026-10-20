package service

// WP 6.1a: a voice channel's chat is gated by the same predicates as a text
// channel's: READ+SEND to post, ATTACH_FILES to attach, slow mode, the archive
// lock, and the timeout. Joining the call is not a condition.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

const (
	vcChatChannel   = int64(20)
	vcChatReadOnly  = int64(2)
	vcChatAttacher  = int64(3)
	vcChatModerator = int64(4)
	vcChatTarget    = int64(5)
)

func newVoiceChatFixture(t *testing.T) (*MessageService, *ChannelService, *db.DB) {
	t.Helper()
	svc, chans, database := newMentionFixture(t)
	seedRole(t, database, &db.Role{ID: 20, Name: "reader-only", Permissions: permissions.ReadMessages, Position: 1})
	seedRole(t, database, &db.Role{ID: 21, Name: "attacher",
		Permissions: permissions.ReadMessages | permissions.SendMessages | permissions.AttachFiles, Position: 1})
	seedUserRole(t, database, vcChatReadOnly, 20)
	seedUserRole(t, database, vcChatAttacher, 21)
	seedUser(t, database, &db.User{ID: vcChatTarget, Username: "target", Status: "online"})
	seedUserRole(t, database, vcChatTarget, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: vcChatChannel, Name: "call", Type: "voice"})
	return svc, chans, database
}

func voiceChatSend(svc *MessageService, userID int64, content string, attachments ...string) error {
	_, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: vcChatChannel, UserID: userID, Username: "u", RoleName: "member",
		Content: content, AttachmentIDs: attachments,
	})
	return err
}

func TestVoiceChannelChat_SendRequiresSendMessages(t *testing.T) {
	svc, _, _ := newVoiceChatFixture(t)
	if err := voiceChatSend(svc, 1, "hello"); err != nil {
		t.Fatalf("member send into a voice channel: %v", err)
	}
	if err := voiceChatSend(svc, vcChatReadOnly, "hello"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("read-only member send = %v, want ErrForbidden", err)
	}
}

// Q1 default: no "joined only" rule. The fixture has no voice state at all, so
// every send above and here is from someone who is not in the call.
func TestVoiceChannelChat_NotJoinedMayReadAndSend(t *testing.T) {
	svc, chans, _ := newVoiceChatFixture(t)
	if err := voiceChatSend(svc, 1, "from outside the call"); err != nil {
		t.Fatalf("send from outside the call: %v", err)
	}
	if _, err := chans.AdmitChannelFocus(context.Background(), 1, vcChatChannel); err != nil {
		t.Fatalf("focus from outside the call: %v", err)
	}
	if msgs, _, err := svc.GetMessages(context.Background(), 1, vcChatChannel, 0, 10); err != nil || len(msgs) != 1 {
		t.Fatalf("history from outside the call = %d messages, err %v, want 1", len(msgs), err)
	}
}

func TestVoiceChannelChat_ArchivedRefused(t *testing.T) {
	svc, _, database := newVoiceChatFixture(t)
	if _, err := database.ExecContext(context.Background(),
		`UPDATE channels SET archived = 1 WHERE id = ?`, vcChatChannel); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if err := voiceChatSend(svc, 1, "into the archive"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("send into an archived voice channel = %v, want ErrForbidden", err)
	}
}

func TestVoiceChannelChat_AttachRequiresAttachFiles(t *testing.T) {
	svc, _, _ := newVoiceChatFixture(t)
	if err := voiceChatSend(svc, 1, "with a file", "upload-1"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("attach without ATTACH_FILES = %v, want ErrForbidden", err)
	}
	if err := voiceChatSend(svc, vcChatAttacher, "with a file", "upload-1"); err != nil {
		t.Fatalf("attach with ATTACH_FILES: %v", err)
	}
}

func TestVoiceChannelChat_SlowModeApplies(t *testing.T) {
	_, _, database := newVoiceChatFixture(t)
	if err := database.SetChannelSlowMode(context.Background(), vcChatChannel, 3600); err != nil {
		t.Fatalf("SetChannelSlowMode: %v", err)
	}
	permSvc := NewPermissionService(database, permissions.NewChecker(database))
	svc := NewMessageService(database, permSvc, auth.NewRateLimiter())
	if err := voiceChatSend(svc, 1, "first"); err != nil {
		t.Fatalf("first send: %v", err)
	}
	if err := voiceChatSend(svc, 1, "second"); !errors.Is(err, ErrSlowMode) {
		t.Fatalf("second send inside the window = %v, want ErrSlowMode", err)
	}
}

// Edge 2: a timeout does not remove someone from the call (CanStayInVoice
// ignores it), so a timed-out member can sit in the voice channel. Their chat
// send is refused with the timeout error, while reading, focus and history
// still work.
func TestVoiceChannelChat_TimedOutCannotSend(t *testing.T) {
	svc, chans, database := newVoiceChatFixture(t)
	ctx := context.Background()
	if _, err := database.CreateMessage(ctx, vcChatChannel, vcChatTarget, "before the timeout", nil); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if _, _, err := database.TimeoutUser(ctx, vcChatTarget, vcChatModerator, nil, "cool off", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	if err := voiceChatSend(svc, vcChatTarget, "during the timeout"); !errors.Is(err, ErrTimedOut) {
		t.Fatalf("send while timed out = %v, want ErrTimedOut", err)
	}
	if _, err := chans.AdmitChannelFocus(ctx, vcChatTarget, vcChatChannel); err != nil {
		t.Errorf("focus while timed out: %v, want allowed", err)
	}
	if msgs, _, err := svc.GetMessages(ctx, vcChatTarget, vcChatChannel, 0, 10); err != nil || len(msgs) != 1 {
		t.Errorf("history while timed out = %d messages, err %v, want 1", len(msgs), err)
	}
}
