package service

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// countingReadStateStore wraps a real *db.DB and counts UpdateReadState calls
// so the test can observe whether channel focus hit the writer.
type countingReadStateStore struct {
	*db.DB
	writes atomic.Int64
}

func (s *countingReadStateStore) UpdateReadState(ctx context.Context, userID, channelID, lastReadMessageID int64) error {
	s.writes.Add(1)
	return s.DB.UpdateReadState(ctx, userID, channelID, lastReadMessageID)
}

// TestHandleChannelFocus_SkipsNoOpReadStateWrite locks the write-skip:
// refocusing a channel whose read state is already current must not occupy
// the single writer connection, while a new message (or outstanding mention)
// must write again.
func TestHandleChannelFocus_SkipsNoOpReadStateWrite(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	st := &countingReadStateStore{DB: database}
	svc := NewChannelService(st, NewPermissionService(database, permissions.NewChecker(database)))
	ctx := context.Background()

	// First focus writes (no read-state row exists yet).
	if _, err := svc.HandleChannelFocus(ctx, 1, 10); err != nil {
		t.Fatalf("focus #1: %v", err)
	}
	if got := st.writes.Load(); got != 1 {
		t.Fatalf("writes after first focus = %d, want 1", got)
	}

	// Refocus with nothing new: the row already says latest+0 mentions.
	if _, err := svc.HandleChannelFocus(ctx, 1, 10); err != nil {
		t.Fatalf("focus #2: %v", err)
	}
	if got := st.writes.Load(); got != 1 {
		t.Fatalf("writes after no-op refocus = %d, want 1 (skipped)", got)
	}

	// A new message moves the latest id — focus must write again.
	if _, err := database.ExecContext(ctx,
		`INSERT INTO messages (channel_id, user_id, content) VALUES (10, 1, 'hi')`); err != nil {
		t.Fatalf("seed message: %v", err)
	}
	if _, err := svc.HandleChannelFocus(ctx, 1, 10); err != nil {
		t.Fatalf("focus #3: %v", err)
	}
	if got := st.writes.Load(); got != 2 {
		t.Fatalf("writes after new message = %d, want 2", got)
	}

	// An outstanding mention must also force the write (it zeroes the badge)
	// even when last_message_id is unchanged.
	if _, err := database.ExecContext(ctx,
		`UPDATE read_states SET mention_count = 3 WHERE user_id = 1 AND channel_id = 10`); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.HandleChannelFocus(ctx, 1, 10); err != nil {
		t.Fatalf("focus #4: %v", err)
	}
	if got := st.writes.Load(); got != 3 {
		t.Fatalf("writes after mention = %d, want 3 (mention must clear)", got)
	}
}
