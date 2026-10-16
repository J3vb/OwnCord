package service

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

type recordingReadNotifier struct {
	mu    sync.Mutex
	calls []db.ReadPointer
}

func (n *recordingReadNotifier) NotifyReadState(_, _ int64, rs db.ReadPointer) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.calls = append(n.calls, rs)
}

func newReadPointerService(t *testing.T) (*MessageService, *recordingReadNotifier, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	svc := NewMessageService(database, NewPermissionService(database, permissions.NewChecker(database)), nil)
	n := &recordingReadNotifier{}
	svc.SetReadStateNotifier(n)
	return svc, n, database
}

func TestMoveReadPointer_AdmissionAndFramesOnlyOnSuccess(t *testing.T) {
	svc, n, database := newReadPointerService(t)
	ctx := context.Background()
	m1, err := database.CreateMessage(ctx, 10, 1, "one", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	m2, err := database.CreateMessage(ctx, 10, 1, "two", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	if _, err := svc.MoveReadPointer(ctx, 1, 999, db.ReadUpTo, m1); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown channel: err = %v, want ErrNotFound", err)
	}
	if _, err := svc.MoveReadPointer(ctx, 1, 10, db.MarkUnread, 0); !errors.Is(err, ErrBadRequest) {
		t.Errorf("mark_unread of id 0: err = %v, want ErrBadRequest", err)
	}
	if _, err := svc.MoveReadPointer(ctx, 1, 10, db.MarkUnread, 1<<40); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("mark_unread of a missing message: err = %v, want db.ErrNotFound", err)
	}
	if len(n.calls) != 0 {
		t.Fatalf("failed moves sent %d frames, want none", len(n.calls))
	}

	rs, err := svc.MoveReadPointer(ctx, 1, 10, db.MarkUnread, m2)
	if err != nil {
		t.Fatalf("MarkUnread: %v", err)
	}
	if rs.LastReadMessageID != m1 || rs.UnreadCount != 1 {
		t.Errorf("rs = %+v, want pointer %d, unread 1", rs, m1)
	}
	if len(n.calls) != 1 || n.calls[0] != rs {
		t.Errorf("notifier calls = %+v, want exactly [%+v]", n.calls, rs)
	}

	if _, err := database.ExecContext(ctx, `UPDATE channels SET archived = 1 WHERE id = 10`); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if _, err := svc.MoveReadPointer(ctx, 1, 10, db.ReadUpTo, m2); !errors.Is(err, ErrForbidden) {
		t.Errorf("archived channel: err = %v, want ErrForbidden", err)
	}
	if len(n.calls) != 1 {
		t.Errorf("a refused move sent a frame: %d calls", len(n.calls))
	}
}
