package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// newTestMessageService creates a MessageService against a real in-memory DB
// pre-populated with one text channel, one user, and a member role that has
// basic permissions. The rate limiter is nil (disabled) to avoid flakiness in
// unit tests.
func newTestMessageService(t *testing.T) (*MessageService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AddReactions,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice", Status: "online"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	checker := permissions.NewChecker(database)
	permSvc := NewPermissionService(database, checker)
	msgSvc := NewMessageService(database, permSvc, nil)
	return msgSvc, database
}

func TestSendMessage_Valid(t *testing.T) {
	svc, _ := newTestMessageService(t)

	result, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10,
		UserID:    1,
		Username:  "alice",
		RoleName:  "member",
		Content:   "hello world",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.MessageID <= 0 {
		t.Fatal("expected positive message ID")
	}
	if result.Content != "hello world" {
		t.Fatalf("expected content %q, got %q", "hello world", result.Content)
	}
	if result.IsDM {
		t.Fatal("expected IsDM to be false for text channel")
	}
}

// TestCanPost_DMBlockEnforced locks the W2-7 property: the plugin-broadcast
// gate delegates to CanPost, so a blocked user is refused from posting into
// a DM — the old broadcast gate's DM branch skipped the block check entirely.
func TestCanPost_DMBlockEnforced(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID: permissions.MemberRoleID, Name: "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages, Position: 1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 50, Name: "dm-1-2", Type: "dm"})
	seedDMParticipant(t, database, 50, 1)
	seedDMParticipant(t, database, 50, 2)
	checker := permissions.NewChecker(database)
	svc := NewMessageService(database, NewPermissionService(database, checker), nil)

	if err := svc.CanPost(context.Background(), 1, 50); err != nil {
		t.Fatalf("unblocked DM participant should be allowed: %v", err)
	}
	seedBlock(t, database, 2, 1) // bob blocks alice
	if err := svc.CanPost(context.Background(), 1, 50); !errors.Is(err, ErrBlocked) {
		t.Fatalf("blocked user must be refused: got %v", err)
	}
	if err := svc.CanPost(context.Background(), 3, 50); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-participant must be refused: got %v", err)
	}
	if err := svc.CanPost(context.Background(), 1, 999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing channel must be NotFound: got %v", err)
	}
}

// TestCanPost_ChannelPermissionRequired: regular channels still require
// READ|SEND via the cached checker.
func TestCanPost_ChannelPermissionRequired(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID: permissions.MemberRoleID, Name: "member",
		Permissions: permissions.ReadMessages, Position: 1, // no SendMessages
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	checker := permissions.NewChecker(database)
	svc := NewMessageService(database, NewPermissionService(database, checker), nil)

	if err := svc.CanPost(context.Background(), 1, 10); !errors.Is(err, ErrForbidden) {
		t.Fatalf("missing SEND_MESSAGES must refuse: got %v", err)
	}
}

// TestCanPost_AnnouncementRequiresManageMessages: announcement channels are
// postable only by users with MANAGE_MESSAGES, even when they hold
// READ|SEND. A plain member is refused; a moderator with MANAGE_MESSAGES posts.
func TestCanPost_AnnouncementRequiresManageMessages(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID: permissions.MemberRoleID, Name: "member",
		Permissions: permissions.ReadMessages | permissions.SendMessages, Position: 1,
	})
	seedRole(t, database, &db.Role{
		ID: permissions.ModeratorRoleID, Name: "moderator",
		Permissions: permissions.ReadMessages | permissions.SendMessages | permissions.ManageMessages, Position: 60,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "mod"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.ModeratorRoleID)
	seedChannel(t, database, &db.Channel{ID: 20, Name: "announcements", Type: "announcement"})
	checker := permissions.NewChecker(database)
	svc := NewMessageService(database, NewPermissionService(database, checker), nil)

	// Member has READ|SEND but not MANAGE_MESSAGES → refused in an announcement channel.
	if err := svc.CanPost(context.Background(), 1, 20); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member without MANAGE_MESSAGES must be refused in announcement channel: got %v", err)
	}
	// Moderator with MANAGE_MESSAGES → allowed.
	if err := svc.CanPost(context.Background(), 2, 20); err != nil {
		t.Fatalf("moderator with MANAGE_MESSAGES must post in announcement channel: got %v", err)
	}
}

// TestSendMessage_AttachmentOwnershipAtomic locks the W1-3 semantics: the
// link UPDATE itself enforces ownership, so a foreign, already-linked, or
// nonexistent attachment is skipped (never linked) while the message still
// sends — no check-then-link race, and retries cannot hard-fail.
func TestSendMessage_AttachmentOwnershipAtomic(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AttachFiles,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice", Status: "online"})
	seedUser(t, database, &db.User{ID: 2, Username: "mallory", Status: "online"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	checker := permissions.NewChecker(database)
	svc := NewMessageService(database, NewPermissionService(database, checker), nil)

	if err := database.CreateAttachment(context.Background(), "att-own", 1, "a.png", "s-a.png", "image/png", 10, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := database.CreateAttachment(context.Background(), "att-foreign", 2, "b.png", "s-b.png", "image/png", 10, nil, nil); err != nil {
		t.Fatal(err)
	}

	result, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", RoleName: "member",
		Content:       "with files",
		AttachmentIDs: []string{"att-own", "att-foreign", "att-missing"},
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if result.MessageID <= 0 {
		t.Fatal("message should persist even when some attachments are skipped")
	}

	own, _ := database.GetAttachmentByID(context.Background(), "att-own")
	if own.MessageID == nil || *own.MessageID != result.MessageID {
		t.Error("sender's own attachment should be linked to the new message")
	}
	foreign, _ := database.GetAttachmentByID(context.Background(), "att-foreign")
	if foreign.MessageID != nil {
		t.Error("another user's attachment must never be linked (IDOR guard)")
	}

	// A retry naming the now-linked attachment must still send.
	retry, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", RoleName: "member",
		Content:       "retry",
		AttachmentIDs: []string{"att-own"},
	})
	if err != nil {
		t.Fatalf("retry with already-linked attachment should still send: %v", err)
	}
	if retry.MessageID <= 0 {
		t.Fatal("retry should persist a message")
	}
	own2, _ := database.GetAttachmentByID(context.Background(), "att-own")
	if own2.MessageID == nil || *own2.MessageID != result.MessageID {
		t.Error("already-linked attachment must stay linked to the original message")
	}
}

func TestSendMessage_EmptyContent(t *testing.T) {
	svc, _ := newTestMessageService(t)

	_, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10,
		UserID:    1,
		Username:  "alice",
		RoleName:  "member",
		Content:   "",
	})
	if err == nil {
		t.Fatal("expected error for empty content")
	}
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got: %v", err)
	}
}

func TestSendMessage_ExceedsMaxLength(t *testing.T) {
	svc, _ := newTestMessageService(t)

	// maxMessageLen is 4000 runes; create content that exceeds it.
	longContent := strings.Repeat("a", 4001)

	_, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10,
		UserID:    1,
		Username:  "alice",
		RoleName:  "member",
		Content:   longContent,
	})
	if err == nil {
		t.Fatal("expected error for content exceeding max length")
	}
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got: %v", err)
	}
}

func TestSendMessage_ChannelNotFound(t *testing.T) {
	svc, _ := newTestMessageService(t)

	_, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 999,
		UserID:    1,
		Username:  "alice",
		Content:   "hello",
	})
	if err == nil {
		t.Fatal("expected error for non-existent channel")
	}
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got: %v", err)
	}
}

func TestSendMessage_InvalidChannelID(t *testing.T) {
	svc, _ := newTestMessageService(t)

	_, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 0,
		UserID:    1,
		Username:  "alice",
		Content:   "hello",
	})
	if err == nil {
		t.Fatal("expected error for zero channel ID")
	}
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got: %v", err)
	}
}

func TestSendMessage_NoPermission(t *testing.T) {
	database := newTestDB(t)
	// Role with ReadMessages only (no SendMessages).
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.ReadMessages,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "readonly", Type: "text"})

	checker := permissions.NewChecker(database)
	permSvc := NewPermissionService(database, checker)
	svc := NewMessageService(database, permSvc, nil)

	_, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10,
		UserID:    1,
		Username:  "alice",
		Content:   "hello",
	})
	if err == nil {
		t.Fatal("expected error for missing SendMessages permission")
	}
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden, got: %v", err)
	}
}

func TestEditMessage_OwnerCanEdit(t *testing.T) {
	svc, _ := newTestMessageService(t)

	// Send a message first.
	result, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10,
		UserID:    1,
		Username:  "alice",
		Content:   "original",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	editResult, err := svc.EditMessage(context.Background(), 1, result.MessageID, "edited content")
	if err != nil {
		t.Fatalf("edit: %v", err)
	}
	if editResult.Content != "edited content" {
		t.Fatalf("expected %q, got %q", "edited content", editResult.Content)
	}
	if editResult.EditedAt == "" {
		t.Fatal("expected non-empty EditedAt after edit")
	}
}

func TestEditMessage_NonOwnerFails(t *testing.T) {
	svc, database := newTestMessageService(t)
	// Add a second user.
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUserRole(t, database, 2, permissions.MemberRoleID)

	// User 1 sends a message.
	result, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10,
		UserID:    1,
		Username:  "alice",
		Content:   "alice's message",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	// User 2 tries to edit it.
	_, err = svc.EditMessage(context.Background(), 2, result.MessageID, "hacked")
	if err == nil {
		t.Fatal("expected error when non-owner edits message")
	}
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden, got: %v", err)
	}
}

func TestEditMessage_EmptyContentFails(t *testing.T) {
	svc, _ := newTestMessageService(t)

	result, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10,
		UserID:    1,
		Username:  "alice",
		Content:   "original",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	_, err = svc.EditMessage(context.Background(), 1, result.MessageID, "")
	if err == nil {
		t.Fatal("expected error for empty edit content")
	}
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got: %v", err)
	}
}

// TestEditMessage_DeniedReadCannotEdit locks the channel-lockout invariant on
// the edit sink, alongside TestDeleteMessage_DeniedReadCannotDelete and
// TestSetMessagePinned_DeniedReadCannotPin. Editing fans new text out to every
// reader of the channel, so it must clear the send gate: unchecking "Can
// access" writes deny = READ_MESSAGES|CONNECT_VOICE and leaves SEND_MESSAGES
// intact, and an announcement channel accepts new text only from
// MANAGE_MESSAGES — so a demoted moderator must not be able to rewrite the
// broadcast they posted while privileged.
func TestEditMessage_DeniedReadCannotEdit(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedRole(t, database, &db.Role{
		ID:          permissions.ModeratorRoleID,
		Name:        "moderator",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.ManageMessages,
		Position:    10,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "mod_bob"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.ModeratorRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "staff-private", Type: "text"})
	seedChannel(t, database, &db.Channel{ID: 11, Name: "announcements", Type: "announcement"})

	permSvc := NewPermissionService(database, permissions.NewChecker(database))
	svc := NewMessageService(database, permSvc, nil)

	sent, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", Content: "private discussion",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	announced, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 11, UserID: 2, Username: "mod_bob", Content: "payroll is on the 1st",
	})
	if err != nil {
		t.Fatalf("send announcement: %v", err)
	}

	// Admin unchecks "Can access" for the member role: READ_MESSAGES and
	// CONNECT_VOICE are denied, SEND_MESSAGES survives the deny mask.
	seedChannelOverride(t, database, permissions.MemberRoleID, 10, 0, permissions.ReadMessages|permissions.ConnectVoice)
	permSvc.InvalidateChannel(10)

	if _, err := svc.EditMessage(context.Background(), 1, sent.MessageID, "payroll moved to http://evil/"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("author denied READ_MESSAGES must not edit: got %v", err)
	}

	// The moderator is demoted to member: MANAGE_MESSAGES is gone, so the
	// announcement they authored is no longer theirs to rewrite.
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	permSvc.InvalidateUser(2)

	if _, err := svc.EditMessage(context.Background(), 2, announced.MessageID, "payroll moved to http://evil/"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("demoted author must not edit an announcement: got %v", err)
	}

	for _, tc := range []struct {
		id   int64
		want string
	}{
		{sent.MessageID, "private discussion"},
		{announced.MessageID, "payroll is on the 1st"},
	} {
		msg, err := database.GetMessage(context.Background(), tc.id)
		if err != nil || msg == nil {
			t.Fatalf("GetMessage(%d): %v", tc.id, err)
		}
		if msg.Content != tc.want {
			t.Fatalf("message %d must survive the refused edit: got %q", tc.id, msg.Content)
		}
	}
}

func TestDeleteMessage_OwnerCanDelete(t *testing.T) {
	svc, _ := newTestMessageService(t)

	result, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10,
		UserID:    1,
		Username:  "alice",
		Content:   "delete me",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	delResult, err := svc.DeleteMessage(context.Background(), 1, result.MessageID)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if delResult.MessageID != result.MessageID {
		t.Fatalf("expected message ID %d, got %d", result.MessageID, delResult.MessageID)
	}
	if delResult.IsDM {
		t.Fatal("expected IsDM to be false")
	}
}

func TestDeleteMessage_NonOwnerWithoutModFails(t *testing.T) {
	svc, database := newTestMessageService(t)
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUserRole(t, database, 2, permissions.MemberRoleID)

	// User 1 sends.
	result, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10,
		UserID:    1,
		Username:  "alice",
		Content:   "important message",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	// User 2 (no ManageMessages) tries to delete user 1's message.
	_, err = svc.DeleteMessage(context.Background(), 2, result.MessageID)
	if err == nil {
		t.Fatal("expected error when non-owner without mod perms deletes message")
	}
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden, got: %v", err)
	}
}

func TestDeleteMessage_ModCanDeleteOthersMessage(t *testing.T) {
	database := newTestDB(t)
	// Mod role has ManageMessages + SendMessages + ReadMessages.
	modPerms := permissions.SendMessages | permissions.ReadMessages | permissions.ManageMessages
	seedRole(t, database, &db.Role{
		ID:          permissions.ModeratorRoleID,
		Name:        "moderator",
		Permissions: modPerms,
		Position:    10,
	})
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "mod_bob"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.ModeratorRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	checker := permissions.NewChecker(database)
	permSvc := NewPermissionService(database, checker)
	svc := NewMessageService(database, permSvc, nil)

	// User 1 sends a message.
	result, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10,
		UserID:    1,
		Username:  "alice",
		Content:   "rule-breaking content",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	// Mod (user 2) deletes it.
	delResult, err := svc.DeleteMessage(context.Background(), 2, result.MessageID)
	if err != nil {
		t.Fatalf("mod delete: %v", err)
	}
	if !delResult.IsMod {
		t.Fatal("expected IsMod to be true for moderator deletion")
	}
}

// TestDeleteMessage_DeniedReadCannotDelete locks the channel-lockout invariant:
// when an admin unchecks "Can access" for a role, the panel writes
// deny = READ_MESSAGES|CONNECT_VOICE and leaves MANAGE_MESSAGES intact, so the
// delete gate must also require READ_MESSAGES — otherwise a moderator excluded
// from a private channel could soft-delete every message in it by enumerating
// message IDs. Mirrors api/channel_authz_test.go's denyReadMessages helper.
func TestDeleteMessage_DeniedReadCannotDelete(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.ModeratorRoleID,
		Name:        "moderator",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.ManageMessages,
		Position:    10,
	})
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "mod_bob"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.ModeratorRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "staff-private", Type: "text"})

	permSvc := NewPermissionService(database, permissions.NewChecker(database))
	svc := NewMessageService(database, permSvc, nil)

	sent, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", Content: "private discussion",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	// Admin unchecks "Can access" for both roles: READ_MESSAGES and
	// CONNECT_VOICE are denied, MANAGE_MESSAGES survives the deny mask.
	denyPrivate := permissions.ReadMessages | permissions.ConnectVoice
	seedChannelOverride(t, database, permissions.ModeratorRoleID, 10, 0, denyPrivate)
	seedChannelOverride(t, database, permissions.MemberRoleID, 10, 0, denyPrivate)
	permSvc.InvalidateChannel(10)

	if _, err := svc.DeleteMessage(context.Background(), 2, sent.MessageID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator denied READ_MESSAGES must not delete: got %v", err)
	}
	if _, err := svc.DeleteMessage(context.Background(), 1, sent.MessageID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("author denied READ_MESSAGES must not delete: got %v", err)
	}

	msg, err := database.GetMessage(context.Background(), sent.MessageID)
	if err != nil || msg == nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if msg.Deleted {
		t.Fatal("message must survive delete attempts from a locked-out role")
	}
}

func TestDeleteMessage_InvalidMessageID(t *testing.T) {
	svc, _ := newTestMessageService(t)

	_, err := svc.DeleteMessage(context.Background(), 1, 0)
	if err == nil {
		t.Fatal("expected error for zero message ID")
	}
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got: %v", err)
	}
}

func TestSendMessage_HTMLSanitized(t *testing.T) {
	svc, _ := newTestMessageService(t)

	result, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10,
		UserID:    1,
		Username:  "alice",
		Content:   `<script>alert("xss")</script>hello`,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(result.Content, "<script>") {
		t.Fatal("expected HTML to be stripped from content")
	}
	if !strings.Contains(result.Content, "hello") {
		t.Fatal("expected safe text to remain in content")
	}
}

// TestSetMessagePinned_DeniedReadCannotPin locks the same channel-lockout
// invariant as TestDeleteMessage_DeniedReadCannotDelete, on the pin sink: an
// admin unchecking "Can access" writes deny = READ_MESSAGES|CONNECT_VOICE and
// leaves MANAGE_MESSAGES intact, so the pin gate must require READ_MESSAGES
// too — otherwise a locked-out moderator can mutate the pin list the real
// members see, and use the success/not-found split as a message-ID oracle.
func TestSetMessagePinned_DeniedReadCannotPin(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.ModeratorRoleID,
		Name:        "moderator",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.ManageMessages,
		Position:    10,
	})
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "mod_bob"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.ModeratorRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "staff-private", Type: "text"})

	permSvc := NewPermissionService(database, permissions.NewChecker(database))
	svc := NewMessageService(database, permSvc, nil)

	sent, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", Content: "announcement",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	// While the moderator can still read the channel, pinning works.
	if err := svc.SetMessagePinned(context.Background(), 2, 10, sent.MessageID, true); err != nil {
		t.Fatalf("moderator with READ_MESSAGES must be able to pin: %v", err)
	}

	denyPrivate := permissions.ReadMessages | permissions.ConnectVoice
	seedChannelOverride(t, database, permissions.ModeratorRoleID, 10, 0, denyPrivate)
	permSvc.InvalidateChannel(10)

	if err := svc.SetMessagePinned(context.Background(), 2, 10, sent.MessageID, false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator denied READ_MESSAGES must not unpin: got %v", err)
	}
	// The existence oracle is closed with it: an id that is not in this channel
	// is refused by the same permission check, not by a distinguishable
	// not-found answer.
	if err := svc.SetMessagePinned(context.Background(), 2, 10, sent.MessageID+999, true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("denied role must not learn which message ids exist: got %v", err)
	}

	pinned, err := database.GetPinnedMessages(context.Background(), 10, 1)
	if err != nil {
		t.Fatalf("GetPinnedMessages: %v", err)
	}
	if len(pinned) != 1 {
		t.Fatalf("pin state must survive the locked-out unpin attempt, got %d pinned", len(pinned))
	}
}

// TestDMBlock_EnforcedOnEveryInteractionSink locks the block invariant across
// all DM verbs, not just send. Blocking used to be checked only in
// checkSendPermission, so a blocked user kept a live channel to the blocker:
// editing an already-sent message fans chat_edited out to both participants, so
// arbitrary new text still arrived, and reactions and pins did the same.
func TestDMBlock_EnforcedOnEveryInteractionSink(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AddReactions,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 50, Name: "dm-1-2", Type: "dm"})
	seedDMParticipant(t, database, 50, 1)
	seedDMParticipant(t, database, 50, 2)

	permSvc := NewPermissionService(database, permissions.NewChecker(database))
	svc := NewMessageService(database, permSvc, nil)

	sent, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi bob",
	})
	if err != nil {
		t.Fatalf("send before block: %v", err)
	}

	seedBlock(t, database, 2, 1) // bob blocks alice

	// Send — the one path that was already enforced.
	if _, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "let me back in",
	}); !errors.Is(err, ErrBlocked) {
		t.Fatalf("blocked send must be refused: got %v", err)
	}

	// Edit — the finding's primary sink.
	if _, err := svc.EditMessage(context.Background(), 1, sent.MessageID, "abusive replacement"); !errors.Is(err, ErrBlocked) {
		t.Fatalf("blocked edit must be refused: got %v", err)
	}
	msg, err := database.GetMessage(context.Background(), sent.MessageID)
	if err != nil || msg == nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if msg.Content != "hi bob" {
		t.Fatalf("content must be unchanged after a blocked edit, got %q", msg.Content)
	}

	// Reactions and pins are the same class of repeatable notification.
	if _, err := svc.AddReaction(context.Background(), 1, sent.MessageID, "👋"); !errors.Is(err, ErrBlocked) {
		t.Fatalf("blocked reaction must be refused: got %v", err)
	}
	if err := svc.SetMessagePinned(context.Background(), 1, 50, sent.MessageID, true); !errors.Is(err, ErrBlocked) {
		t.Fatalf("blocked pin must be refused: got %v", err)
	}

	// The block is symmetric, matching the pre-existing send-path semantics.
	if _, err := svc.EditMessage(context.Background(), 2, sent.MessageID, "bob edits"); !errors.Is(err, ErrBlocked) {
		t.Fatalf("blocker is equally refused, matching IsEitherBlocked: got %v", err)
	}
}
