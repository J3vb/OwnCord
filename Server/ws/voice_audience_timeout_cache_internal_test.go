package ws

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// audienceTimeoutSpyStore counts the store reads that can answer "is this
// user timed out" behind the hub's PermissionService.
type audienceTimeoutSpyStore struct {
	service.Store
	hasActive atomic.Int64
	listAll   atomic.Int64
}

func (s *audienceTimeoutSpyStore) HasActiveTimeout(ctx context.Context, userID int64) (bool, error) {
	s.hasActive.Add(1)
	return s.Store.HasActiveTimeout(ctx, userID)
}

func (s *audienceTimeoutSpyStore) ListActiveTimeoutExpiries(ctx context.Context) ([]db.ActiveTimeoutExpiry, error) {
	s.listAll.Add(1)
	return s.Store.ListActiveTimeoutExpiries(ctx)
}

// P5-O02: a voice event's READ audience resolves every connected user's
// Subject, and TimedOut now comes from PermissionService's in-memory
// mirror — so a voice join with 2,000 connected members issues no timeout
// query at all (before the mirror: one HasActiveTimeout per connected user).
func TestChannelReadAudience_2000Connected_NoTimeoutQueries(t *testing.T) {
	const connected = 2000
	database, voiceChID := applyTimeoutMuteTestDB(t)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `
		WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO users (username, password, role_id) SELECT 'member-' || i, 'hash', 4 FROM n`, connected); err != nil {
		t.Fatalf("seed users: %v", err)
	}

	h := newTestHub(t, database, nil, nil)
	spy := &audienceTimeoutSpyStore{Store: database}
	h.perms = service.NewPermissionService(spy, permissions.NewChecker(spy))
	if err := h.perms.RefreshTimeouts(ctx); err != nil { // the boot load
		t.Fatalf("RefreshTimeouts: %v", err)
	}
	spy.listAll.Store(0)

	rows, err := database.QueryContext(ctx, `SELECT id FROM users`)
	if err != nil {
		t.Fatalf("list users: %v", err)
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan user: %v", err)
		}
		registerEmitTestClient(h, id, 0)
	}
	if err := rows.Close(); err != nil {
		t.Fatalf("close rows: %v", err)
	}

	audience := h.channelReadAudience(ctx, voiceChID)
	if len(audience) != connected {
		t.Fatalf("audience = %d users, want all %d connected members", len(audience), connected)
	}
	if h, l := spy.hasActive.Load(), spy.listAll.Load(); h != 0 || l != 0 {
		t.Fatalf("timeout reads for one voice audience = %d HasActiveTimeout + %d ListActiveTimeoutExpiries, want 0", h, l)
	}
}
