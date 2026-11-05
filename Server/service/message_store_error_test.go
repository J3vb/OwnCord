package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

var errStoreBusy = errors.New("database is locked (SQLITE_BUSY)")

// busyStore fails the chosen message reads and writes with a transient store
// error, the way a busy database or a spent deadline does.
type busyStore struct {
	Store
	failGet, failEdit, failDelete bool
}

func (s busyStore) GetMessage(ctx context.Context, id int64) (*db.Message, error) {
	if s.failGet {
		return nil, errStoreBusy
	}
	return s.Store.GetMessage(ctx, id)
}

func (s busyStore) EditMessage(ctx context.Context, id, userID int64, content string) (*db.Message, error) {
	if s.failEdit {
		return nil, errStoreBusy
	}
	return s.Store.EditMessage(ctx, id, userID, content)
}

func (s busyStore) DeleteMessageWithRemoval(ctx context.Context, msgID, deleterID int64, isMod bool, authorID int64, reportID *int64, reason string) error {
	if s.failDelete {
		return errStoreBusy
	}
	return s.Store.DeleteMessageWithRemoval(ctx, msgID, deleterID, isMod, authorID, reportID, reason)
}

// wantInternal checks a store failure comes back as an internal error that keeps
// its cause, never as a permission refusal.
func wantInternal(t *testing.T, op string, err error) {
	t.Helper()
	if !errors.Is(err, ErrInternal) || !errors.Is(err, errStoreBusy) {
		t.Fatalf("%s: err = %v, want ErrInternal wrapping the store error", op, err)
	}
	if errors.Is(err, ErrForbidden) {
		t.Fatalf("%s: a store failure must not read as a permission refusal: %v", op, err)
	}
}

// newStoreErrorFixture is a text channel (10) with two members, alice (1) and bob (2).
func newStoreErrorFixture(t *testing.T) (*MessageService, *db.DB, *PermissionService) {
	t.Helper()
	svc, database := newTestMessageService(t)
	seedUser(t, database, &db.User{ID: 2, Username: "bob", Status: "online"})
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	return svc, database, NewPermissionService(database, permissions.NewChecker(database))
}

func TestEditMessage_StoreFailureIsInternalNotForbidden(t *testing.T) {
	plain, database, permSvc := newStoreErrorFixture(t)
	ctx := context.Background()
	sent, err := plain.SendMessage(ctx, SendMessageParams{ChannelID: 10, UserID: 1, Username: "alice", RoleName: "member", Content: "hi bob"})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	for name, st := range map[string]busyStore{
		"write": {Store: database, failEdit: true},
		"load":  {Store: database, failGet: true},
	} {
		svc := NewMessageService(st, permSvc, nil)
		_, err := svc.EditMessage(ctx, 1, sent.MessageID, "edited")
		wantInternal(t, "edit "+name, err)
	}
	if msg, err := database.GetMessage(ctx, sent.MessageID); err != nil || msg.Content != "hi bob" {
		t.Fatalf("content after failed edits = %v (err %v), want it unchanged", msg, err)
	}

	// Real refusals keep their answer: someone else's message, a missing one.
	if _, err := plain.EditMessage(ctx, 2, sent.MessageID, "not mine"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("edit by a non-author: err = %v, want ErrForbidden", err)
	}
	if _, err := plain.EditMessage(ctx, 1, sent.MessageID+1000, "gone"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("edit of a missing message: err = %v, want ErrForbidden", err)
	}
}

func TestDeleteMessage_StoreFailureIsInternalNotForbidden(t *testing.T) {
	plain, database, permSvc := newStoreErrorFixture(t)
	ctx := context.Background()
	sent, err := plain.SendMessage(ctx, SendMessageParams{ChannelID: 10, UserID: 1, Username: "alice", RoleName: "member", Content: "hi bob"})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	for name, st := range map[string]busyStore{
		"write": {Store: database, failDelete: true},
		"load":  {Store: database, failGet: true},
	} {
		svc := NewMessageService(st, permSvc, nil)
		_, err := svc.DeleteMessage(ctx, 1, sent.MessageID)
		wantInternal(t, "delete "+name, err)
	}
	if msg, err := database.GetMessage(ctx, sent.MessageID); err != nil || msg.Deleted {
		t.Fatalf("message after failed deletes = %v (err %v), want it still live", msg, err)
	}

	if _, err := plain.DeleteMessage(ctx, 2, sent.MessageID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("delete by a non-author: err = %v, want ErrForbidden", err)
	}
	if _, err := plain.DeleteMessage(ctx, 1, sent.MessageID); err != nil {
		t.Fatalf("own delete after the failures: %v", err)
	}
}

func TestSoftDeleteRow_StoreRefusalStaysForbidden(t *testing.T) {
	plain, _, _ := newStoreErrorFixture(t)
	ctx := context.Background()
	sent, err := plain.SendMessage(ctx, SendMessageParams{ChannelID: 10, UserID: 1, Username: "alice", RoleName: "member", Content: "hi bob"})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	// The store's own ownership check (a non-moderator deleting another's row)
	// is a refusal, not a failure.
	err = plain.softDeleteRow(ctx, sent.MessageID, 2, false, 1, nil, "", false)
	if !errors.Is(err, ErrForbidden) || errors.Is(err, ErrInternal) {
		t.Fatalf("softDeleteRow by a non-owner: err = %v, want ErrForbidden", err)
	}
}
