package service

import (
	"context"
	"errors"
	"testing"

	"github.com/owncord/server/db"
)

// GetUserByID has no banned filter (unlike ListMembers and the other lookups
// that normally surface a user to a caller), so CreateDM/CreateGroupDM must
// gate on ban status themselves or a hand-crafted recipient_id naming a
// deleted/banned account creates a dead-end DM channel and participant rows
// for the tombstone user (v116).

func TestDMService_CreateDM_RefusesBannedRecipient(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob", Banned: true})

	svc := NewDMService(database)
	_, err := svc.CreateDM(context.Background(), 1, 2)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("CreateDM to a banned recipient = %v, want ErrNotFound", err)
	}
}

// A temporary ban that has already expired must not block the DM: login,
// WS auth and every other gate already treat this user as not-banned
// (auth.IsEffectivelyBanned), so refusing the DM here would be a stricter,
// inconsistent rule.
func TestDMService_CreateDM_AllowsLapsedTemporaryBan(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob", Banned: true})
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET ban_expires = '2020-01-01 00:00:00' WHERE id = 2`); err != nil {
		t.Fatalf("set stale ban_expires: %v", err)
	}

	svc := NewDMService(database)
	result, err := svc.CreateDM(context.Background(), 1, 2)
	if err != nil {
		t.Fatalf("CreateDM to a user with a lapsed temporary ban: %v", err)
	}
	if result.Channel == nil {
		t.Fatal("expected a DM channel to be created")
	}
}

func TestDMService_CreateGroupDM_RefusesBannedRecipient(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUser(t, database, &db.User{ID: 3, Username: "carol", Banned: true})

	svc := NewDMService(database)
	_, err := svc.CreateGroupDM(context.Background(), 1, []int64{2, 3}, "")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("CreateGroupDM with a banned recipient = %v, want ErrNotFound", err)
	}
}

// cancelAfterCreateGroupDMStore wraps a real *db.DB and cancels a context the
// instant CreateGroupDMChannel returns successfully — simulating a client
// disconnect that lands exactly in the gap between the channel's commit and
// the service's post-commit GetDMParticipants read.
type cancelAfterCreateGroupDMStore struct {
	*db.DB
	cancel context.CancelFunc
}

func (s *cancelAfterCreateGroupDMStore) CreateGroupDMChannel(ctx context.Context, name string, participantIDs []int64) (*db.Channel, error) {
	ch, err := s.DB.CreateGroupDMChannel(ctx, name, participantIDs)
	if err == nil {
		s.cancel()
	}
	return ch, err
}

// OC-0004: CreateGroupDMChannel commits the channel, all dm_participants rows
// and all dm_open_state rows in one transaction. The subsequent
// GetDMParticipants read used to run on the same cancellable request context,
// so a client disconnect landing right after the commit (context cancelled
// in the gap) turned a fully-persisted group DM into a reported failure —
// inviting a client retry that, because group DMs are duplicate-by-design
// (db/dm_queries.go CreateGroupDMChannel doc), creates a second identical
// group.
func TestDMService_CreateGroupDM_SurvivesCancelledPostCommitRead(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUser(t, database, &db.User{ID: 3, Username: "carol"})

	ctx, cancel := context.WithCancel(context.Background())
	st := &cancelAfterCreateGroupDMStore{DB: database}
	st.cancel = cancel

	svc := NewDMService(st)
	result, err := svc.CreateGroupDM(ctx, 1, []int64{2, 3}, "")
	if err != nil {
		t.Fatalf("CreateGroupDM with context cancelled right after commit: %v (the channel is already persisted at this point — this must not fail the request)", err)
	}
	if result.Channel == nil {
		t.Fatal("expected a created channel even though the post-commit context was cancelled")
	}
	if len(result.ParticipantIDs) != 3 {
		t.Fatalf("ParticipantIDs = %v, want 3 entries so the caller can still broadcast dm_channel_open", result.ParticipantIDs)
	}

	// The channel must actually be persisted — a retry after this "failure"
	// would otherwise be indistinguishable from creating a brand new group.
	var count int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM dm_participants WHERE channel_id = ?`, result.Channel.ID,
	).Scan(&count); err != nil {
		t.Fatalf("count participants: %v", err)
	}
	if count != 3 {
		t.Fatalf("persisted participant rows = %d, want 3", count)
	}
}
