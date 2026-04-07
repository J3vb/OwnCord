package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/store"
)

// newTestMessageService creates a MessageService with a MemStore pre-populated
// with one text channel, one user, and a member role that has basic permissions.
// The rate limiter is nil (disabled) to avoid flakiness in unit tests.
func newTestMessageService() (*MessageService, *store.MemStore) {
	ms := store.NewMemStore()
	ms.SeedRole(&db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AddReactions,
		Position:    1,
	})
	ms.SeedUserRole(1, permissions.MemberRoleID)
	ms.SeedUser(&db.User{ID: 1, Username: "alice", Status: "online"})
	ms.SeedChannel(&db.Channel{ID: 10, Name: "general", Type: "text"})

	checker := permissions.NewChecker(ms)
	permSvc := NewPermissionService(ms, checker)
	msgSvc := NewMessageService(ms, permSvc, nil)
	return msgSvc, ms
}

func TestSendMessage_Valid(t *testing.T) {
	svc, _ := newTestMessageService()

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

func TestSendMessage_EmptyContent(t *testing.T) {
	svc, _ := newTestMessageService()

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
	svc, _ := newTestMessageService()

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
	svc, _ := newTestMessageService()

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
	svc, _ := newTestMessageService()

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
	ms := store.NewMemStore()
	// Role with ReadMessages only (no SendMessages).
	ms.SeedRole(&db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.ReadMessages,
		Position:    1,
	})
	ms.SeedUserRole(1, permissions.MemberRoleID)
	ms.SeedUser(&db.User{ID: 1, Username: "alice"})
	ms.SeedChannel(&db.Channel{ID: 10, Name: "readonly", Type: "text"})

	checker := permissions.NewChecker(ms)
	permSvc := NewPermissionService(ms, checker)
	svc := NewMessageService(ms, permSvc, nil)

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
	svc, _ := newTestMessageService()

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

	editResult, err := svc.EditMessage(1, result.MessageID, "edited content")
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
	svc, ms := newTestMessageService()
	// Add a second user.
	ms.SeedUserRole(2, permissions.MemberRoleID)
	ms.SeedUser(&db.User{ID: 2, Username: "bob"})

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
	_, err = svc.EditMessage(2, result.MessageID, "hacked")
	if err == nil {
		t.Fatal("expected error when non-owner edits message")
	}
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden, got: %v", err)
	}
}

func TestEditMessage_EmptyContentFails(t *testing.T) {
	svc, _ := newTestMessageService()

	result, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10,
		UserID:    1,
		Username:  "alice",
		Content:   "original",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	_, err = svc.EditMessage(1, result.MessageID, "")
	if err == nil {
		t.Fatal("expected error for empty edit content")
	}
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got: %v", err)
	}
}

func TestDeleteMessage_OwnerCanDelete(t *testing.T) {
	svc, _ := newTestMessageService()

	result, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10,
		UserID:    1,
		Username:  "alice",
		Content:   "delete me",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	delResult, err := svc.DeleteMessage(1, result.MessageID)
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
	svc, ms := newTestMessageService()
	ms.SeedUserRole(2, permissions.MemberRoleID)
	ms.SeedUser(&db.User{ID: 2, Username: "bob"})

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
	_, err = svc.DeleteMessage(2, result.MessageID)
	if err == nil {
		t.Fatal("expected error when non-owner without mod perms deletes message")
	}
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden, got: %v", err)
	}
}

func TestDeleteMessage_ModCanDeleteOthersMessage(t *testing.T) {
	ms := store.NewMemStore()
	// Mod role has ManageMessages + SendMessages + ReadMessages.
	modPerms := permissions.SendMessages | permissions.ReadMessages | permissions.ManageMessages
	ms.SeedRole(&db.Role{
		ID:          permissions.ModeratorRoleID,
		Name:        "moderator",
		Permissions: modPerms,
		Position:    10,
	})
	ms.SeedRole(&db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	ms.SeedUserRole(1, permissions.MemberRoleID)
	ms.SeedUserRole(2, permissions.ModeratorRoleID)
	ms.SeedUser(&db.User{ID: 1, Username: "alice"})
	ms.SeedUser(&db.User{ID: 2, Username: "mod_bob"})
	ms.SeedChannel(&db.Channel{ID: 10, Name: "general", Type: "text"})

	checker := permissions.NewChecker(ms)
	permSvc := NewPermissionService(ms, checker)
	svc := NewMessageService(ms, permSvc, nil)

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
	delResult, err := svc.DeleteMessage(2, result.MessageID)
	if err != nil {
		t.Fatalf("mod delete: %v", err)
	}
	if !delResult.IsMod {
		t.Fatal("expected IsMod to be true for moderator deletion")
	}
}

func TestDeleteMessage_InvalidMessageID(t *testing.T) {
	svc, _ := newTestMessageService()

	_, err := svc.DeleteMessage(1, 0)
	if err == nil {
		t.Fatal("expected error for zero message ID")
	}
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got: %v", err)
	}
}

func TestSendMessage_HTMLSanitized(t *testing.T) {
	svc, _ := newTestMessageService()

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
