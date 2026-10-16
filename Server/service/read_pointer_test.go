package service

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
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

// moveCountingStore counts MoveReadPointer calls, each of which opens a writer
// transaction.
type moveCountingStore struct {
	*db.DB
	moves atomic.Int64
}

func (s *moveCountingStore) MoveReadPointer(ctx context.Context, userID, channelID int64, op db.ReadPointerOp, messageID int64) (db.ReadPointer, error) {
	s.moves.Add(1)
	return s.DB.MoveReadPointer(ctx, userID, channelID, op, messageID)
}

// Read-at-latest on a row that is already current must not open a writer
// transaction, and must still send a frame that matches what the write path
// would have returned.
func TestMoveReadPointer_AtLatestSkipsWriterWhenCurrent(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID: permissions.MemberRoleID, Name: "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages, Position: 1,
	})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	st := &moveCountingStore{DB: database}
	svc := NewMessageService(st, NewPermissionService(database, permissions.NewChecker(database)), nil)
	n := &recordingReadNotifier{}
	svc.SetReadStateNotifier(n)
	ctx := context.Background()
	m1, err := database.CreateMessage(ctx, 10, 1, "one", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	first, err := svc.MoveReadPointer(ctx, 1, 10, db.ReadAtLatest, 0)
	if err != nil || st.moves.Load() != 1 {
		t.Fatalf("first read (err %v, moves %d): the row did not exist, so it must write", err, st.moves.Load())
	}
	second, err := svc.MoveReadPointer(ctx, 1, 10, db.ReadAtLatest, 0)
	if err != nil {
		t.Fatalf("second read: %v", err)
	}
	if got := st.moves.Load(); got != 1 {
		t.Errorf("writer transactions = %d, want 1: a current row must not open another", got)
	}
	if second != first || second.LastReadMessageID != m1 || second.UnreadCount != 0 || second.MentionCount != 0 {
		t.Errorf("skip result = %+v, want the write path's %+v", second, first)
	}
	if len(n.calls) != 2 || n.calls[1] != second {
		t.Errorf("notifier calls = %+v, want a frame for the skipped call too", n.calls)
	}

	// A new message makes the row stale: back to the write path.
	if _, err := database.CreateMessage(ctx, 10, 1, "two", nil); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if _, err := svc.MoveReadPointer(ctx, 1, 10, db.ReadAtLatest, 0); err != nil || st.moves.Load() != 2 {
		t.Errorf("stale row (err %v, moves %d): want a second write", err, st.moves.Load())
	}
}
