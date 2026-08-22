package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

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

// OC-0194: same defect as OC-0192/OC-0195 (see
// TestUpdateProfile_OversizedDisplayNameAndAboutRejectedBeforeSanitizing and
// TestHandlePresenceUpdate_OversizedCustomStatusRejectedBeforeSanitizing) but
// reached via CreateGroupDM. /api/v1/dms carries no rate limiter, and
// CreateGroupDM runs cleanText(name) *before* the recipient-existence/ban/
// block checks, so an adversarial nested-entity name pays the full quadratic
// sanitizeToFixpoint cost even for a request that is going to 404 on its
// recipients. The raw-byte guard must reject on cheap byte length alone.
func TestDMService_CreateGroupDM_OversizedNameRejectedBeforeSanitizing(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	svc := NewDMService(database)

	// Adversarial nested-entity payload (16 KB) — see sanitizeToFixpoint's
	// doc comment (message.go) for why this shape is quadratic to sanitize.
	huge := "&" + strings.Repeat("amp;", 4000) + "lt;"

	start := time.Now()
	// Recipients 999998/999999 do not exist. The guard must fire before the
	// per-recipient GetUserByID/ban checks reach the database, matching the
	// order CreateGroupDM actually runs them in.
	_, err := svc.CreateGroupDM(context.Background(), 1, []int64{999998, 999999}, huge)
	elapsed := time.Since(start)
	if !errors.Is(err, ErrBadRequest) {
		t.Errorf("CreateGroupDM with oversized name err = %v, want ErrBadRequest", err)
	}
	// A guard that runs before sanitizing rejects in well under a
	// millisecond; the pre-fix code spends well over 150ms in
	// sanitizeToFixpoint on this payload before the rune-count check ever
	// runs. 150ms gives generous margin over noise while staying far below
	// the unguarded cost.
	if elapsed > 150*time.Millisecond {
		t.Errorf("CreateGroupDM with oversized name took %v, want well under 150ms (raw field must be bounded before sanitizing)", elapsed)
	}
}

// OC-0194 sibling: RenameGroupDM runs the identical cleanText(name) call and
// must be bounded the same way as CreateGroupDM.
func TestDMService_RenameGroupDM_OversizedNameRejectedBeforeSanitizing(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUser(t, database, &db.User{ID: 3, Username: "carol"})
	svc := NewDMService(database)

	created, err := svc.CreateGroupDM(context.Background(), 1, []int64{2, 3}, "")
	if err != nil {
		t.Fatalf("setup CreateGroupDM: %v", err)
	}

	huge := "&" + strings.Repeat("amp;", 4000) + "lt;"

	start := time.Now()
	_, err = svc.RenameGroupDM(context.Background(), 1, created.Channel.ID, huge)
	elapsed := time.Since(start)
	if !errors.Is(err, ErrBadRequest) {
		t.Errorf("RenameGroupDM with oversized name err = %v, want ErrBadRequest", err)
	}
	if elapsed > 150*time.Millisecond {
		t.Errorf("RenameGroupDM with oversized name took %v, want well under 150ms (raw field must be bounded before sanitizing)", elapsed)
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

// ─── OC-0304: disconnected recipients must read as offline ────────────────
//
// users.status keeps a *chosen* idle/dnd/invisible across a disconnect
// (MarkUserDisconnected only ever rewrites "online" -> "offline") so a
// reconnect can honour it. ws/serve_ready.go's presentableMembers documents
// the resulting obligation on every read path: "a member with no live
// connection is offline, whatever the row says." DMSummaryFor, ListDMs and
// CreateGroupDM are the service-layer choke points every DM payload in this
// package is built from, so each must apply that rule once SetOnlineChecker
// is wired — otherwise a signed-out user's last chosen status leaks into the
// DM sidebar as a live presence dot, contradicting the member list right
// next to it.

func TestDMService_DMSummaryFor_RecipientOfflineWhenDisconnected(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob", Status: db.StatusDND})

	svc := NewDMService(database)
	created, err := svc.CreateDM(context.Background(), 1, 2)
	if err != nil {
		t.Fatalf("setup CreateDM: %v", err)
	}

	// Bob chose "dnd" and then signed out — nobody holds a live connection.
	svc.SetOnlineChecker(func(userID int64) bool { return false })

	summary, err := svc.DMSummaryFor(context.Background(), 1, created.Channel.ID)
	if err != nil {
		t.Fatalf("DMSummaryFor: %v", err)
	}
	if summary.Recipient.Status != db.StatusOffline {
		t.Errorf("Recipient.Status = %q, want %q (bob has no live connection, so his saved %q must not leak through)",
			summary.Recipient.Status, db.StatusOffline, db.StatusDND)
	}
	if len(summary.Recipients) != 1 || summary.Recipients[0].Status != db.StatusOffline {
		t.Errorf("Recipients = %+v, want a single offline entry", summary.Recipients)
	}
}

func TestDMService_ListDMs_RecipientOfflineWhenDisconnected(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob", Status: db.StatusDND})

	svc := NewDMService(database)
	if _, err := svc.CreateDM(context.Background(), 1, 2); err != nil {
		t.Fatalf("setup CreateDM: %v", err)
	}

	svc.SetOnlineChecker(func(userID int64) bool { return false })

	dms, err := svc.ListDMs(context.Background(), 1)
	if err != nil {
		t.Fatalf("ListDMs: %v", err)
	}
	if len(dms) != 1 {
		t.Fatalf("ListDMs: got %d channels, want 1", len(dms))
	}
	if dms[0].Recipient.Status != db.StatusOffline {
		t.Errorf("Recipient.Status = %q, want %q (bob has no live connection, so his saved %q must not leak through)",
			dms[0].Recipient.Status, db.StatusOffline, db.StatusDND)
	}
}

func TestDMService_CreateGroupDM_ParticipantOfflineWhenDisconnected(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob", Status: db.StatusDND})
	seedUser(t, database, &db.User{ID: 3, Username: "carol"})

	svc := NewDMService(database)
	svc.SetOnlineChecker(func(userID int64) bool { return userID != 2 })

	result, err := svc.CreateGroupDM(context.Background(), 1, []int64{2, 3}, "")
	if err != nil {
		t.Fatalf("CreateGroupDM: %v", err)
	}

	var bobStatus string
	found := false
	for _, p := range result.Participants {
		if p.ID == 2 {
			bobStatus = p.Status
			found = true
		}
	}
	if !found {
		t.Fatalf("bob missing from Participants: %+v", result.Participants)
	}
	if bobStatus != db.StatusOffline {
		t.Errorf("bob's Status = %q, want %q (bob has no live connection, so his saved %q must not leak through)",
			bobStatus, db.StatusOffline, db.StatusDND)
	}
}
