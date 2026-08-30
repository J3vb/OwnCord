package service

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// BenchmarkReadStateWrite is one mark_read (or channel_focus — they share this
// one service call, see handleMarkReadV2) against an in-memory SQLite:
// HandleChannelFocus resolves the session-admission subject for the caller,
// reads the channel's latest message id and the caller's read state, then takes
// the UpdateReadState branch on the single writer connection.
//
// Each iteration focuses a DIFFERENT user, so the write always happens. The
// same user refocusing the same channel writes exactly once and is thereafter
// skipped by the no-op guard in HandleChannelFocus (same last_message_id, no
// mentions), which would measure the skip instead of the write. Every user the
// loop needs is seeded in one statement before the timer starts — b.N is known
// by then.
func BenchmarkReadStateWrite(b *testing.B) {
	database := newTestDB(b)
	ctx := context.Background()

	seedRole(b, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedChannel(b, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	if _, err := database.ExecContext(ctx,
		`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?)
		 INSERT INTO users (id, username, password, role_id)
		 SELECT i, 'bench-' || i, '', ? FROM seq`,
		b.N, permissions.MemberRoleID,
	); err != nil {
		b.Fatalf("seed users: %v", err)
	}
	// A channel with no messages resolves latest_message_id to 0, which the
	// read state then matches — the write must have something to advance to.
	if _, err := database.ExecContext(ctx,
		`INSERT INTO messages (channel_id, user_id, content) VALUES (10, 1, 'bench')`,
	); err != nil {
		b.Fatalf("seed message: %v", err)
	}

	svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))

	b.ReportAllocs()
	b.ResetTimer()
	for i := range b.N {
		if _, err := svc.HandleChannelFocus(ctx, int64(i+1), 10); err != nil {
			b.Fatalf("HandleChannelFocus(user %d): %v", i+1, err)
		}
	}
}
