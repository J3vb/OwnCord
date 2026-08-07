package ws

import (
	"context"
	"testing"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/service"
)

// newFocusTestDeps creates an in-memory DB with a user (role=Owner, id=1) and
// a text channel, returning deps and the IDs needed for assertions.
func newFocusTestDeps(t *testing.T) (PresenceDeps, int64, int64) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	userID, err := database.CreateUser(context.Background(), "focuser", "hash", 1) // Owner role
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	chID, err := database.CreateChannel(context.Background(), "focus-chan", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	st := database
	svc := service.New(st, auth.NewRateLimiter())
	deps := PresenceDeps{Limiter: nil, ChannelSvc: svc.Channels}
	return deps, userID, chID
}

func TestChannelFocusV2_HappyPath_SetsChannelID(t *testing.T) {
	deps, userID, chID := newFocusTestDeps(t)
	cmd := ChannelFocusCmd{userID: userID, channelID: chID}
	info := ClientInfo{UserID: userID, Username: "focuser"}

	result := handleChannelFocusV2(context.Background(), cmd, info, deps)

	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}
	if result.SetChannelID == nil {
		t.Fatal("expected SetChannelID to be set")
	}
	if *result.SetChannelID != chID {
		t.Errorf("SetChannelID = %d, want %d", *result.SetChannelID, chID)
	}
}

func TestChannelFocusV2_InvalidChannelID_SilentDrop(t *testing.T) {
	deps, userID, _ := newFocusTestDeps(t)
	cmd := ChannelFocusCmd{userID: userID, channelID: 0}
	info := ClientInfo{UserID: userID}

	result := handleChannelFocusV2(context.Background(), cmd, info, deps)

	// channelID <= 0 → silently dropped (no error, no SetChannelID).
	if result.Error != nil {
		t.Errorf("expected nil error for invalid channel_id, got %v", result.Error)
	}
	if result.SetChannelID != nil {
		t.Errorf("expected nil SetChannelID for invalid channel_id, got %d", *result.SetChannelID)
	}
}

func TestChannelFocusV2_ChannelNotFound_SilentDrop(t *testing.T) {
	deps, userID, _ := newFocusTestDeps(t)
	cmd := ChannelFocusCmd{userID: userID, channelID: 99999}
	info := ClientInfo{UserID: userID}

	result := handleChannelFocusV2(context.Background(), cmd, info, deps)

	if result.Error != nil {
		t.Errorf("expected nil error for missing channel, got %v", result.Error)
	}
	if result.SetChannelID != nil {
		t.Errorf("expected nil SetChannelID for missing channel, got %d", *result.SetChannelID)
	}
}

func TestChannelFocusV2_NoPermission_ReturnsForbidden(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	// Use Member role (id=4) and create a channel with a deny override.
	userID, _ := database.CreateUser(context.Background(), "noperm", "hash", 4)
	chID, _ := database.CreateChannel(context.Background(), "restricted", "text", "", "", 0)

	// Deny READ_MESSAGES for Member role on this channel via raw SQL.
	_, err = database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, ?)`,
		chID, permissions.ReadMessages,
	)
	if err != nil {
		t.Fatalf("INSERT channel_overrides: %v", err)
	}

	st := database
	svc := service.New(st, auth.NewRateLimiter())
	deps := PresenceDeps{Limiter: nil, ChannelSvc: svc.Channels}

	cmd := ChannelFocusCmd{userID: userID, channelID: chID}
	info := ClientInfo{UserID: userID, Username: "noperm"}

	result := handleChannelFocusV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected FORBIDDEN error for denied permission")
	}
	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeForbidden {
		t.Errorf("expected code %q, got %q", ErrCodeForbidden, ce.Code)
	}
}

func TestChannelFocusV2_RateLimited_SilentDrop(t *testing.T) {
	deps, userID, chID := newFocusTestDeps(t)
	deps.Limiter = auth.NewRateLimiter()
	cmd := ChannelFocusCmd{userID: userID, channelID: chID}
	info := ClientInfo{UserID: userID, Username: "focuser"}

	// Every frame drives an unmetered SQLite write; 5/s must be enough for
	// any legitimate focus churn, and the 6th within the window is dropped.
	for i := range 5 {
		res := handleChannelFocusV2(context.Background(), cmd, info, deps)
		if res.SetChannelID == nil {
			t.Fatalf("in-budget focus %d must set the channel id", i)
		}
	}
	res := handleChannelFocusV2(context.Background(), cmd, info, deps)
	if res.SetChannelID != nil {
		t.Error("rate-limited channel_focus must be dropped (no SetChannelID)")
	}
	if res.Error != nil {
		t.Errorf("silent drop expected, got error %v", res.Error)
	}
}

func TestMarkReadV2_RateLimited_SkipsReadStateWrite(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	userID, _ := database.CreateUser(context.Background(), "marklimit", "hash", 1)
	chID, _ := database.CreateChannel(context.Background(), "mark-chan", "text", "", "", 0)
	svc := service.New(database, auth.NewRateLimiter())
	deps := PresenceDeps{Limiter: auth.NewRateLimiter(), ChannelSvc: svc.Channels}
	info := ClientInfo{UserID: userID, Username: "marklimit"}

	insertMsg := func(content string) int64 {
		t.Helper()
		res, execErr := database.ExecContext(context.Background(),
			`INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)`,
			chID, userID, content)
		if execErr != nil {
			t.Fatalf("insert message: %v", execErr)
		}
		id, _ := res.LastInsertId()
		return id
	}
	readStateID := func() int64 {
		t.Helper()
		var id int64
		if scanErr := database.QueryRowContext(context.Background(),
			`SELECT last_message_id FROM read_states WHERE user_id = ? AND channel_id = ?`,
			userID, chID).Scan(&id); scanErr != nil {
			t.Fatalf("read read_states: %v", scanErr)
		}
		return id
	}

	m1 := insertMsg("first")
	// Exhaust the shared focus/mark_read budget (5/s).
	for range 5 {
		handleMarkReadV2(context.Background(), MarkReadCmd{userID: userID, channelID: chID}, info, deps)
	}
	if got := readStateID(); got != m1 {
		t.Fatalf("read state after in-budget mark_read = %d, want %d", got, m1)
	}

	insertMsg("second")
	// The 6th frame in the window must not reach the SQLite writer.
	handleMarkReadV2(context.Background(), MarkReadCmd{userID: userID, channelID: chID}, info, deps)
	if got := readStateID(); got != m1 {
		t.Errorf("rate-limited mark_read advanced read state to %d, want it held at %d", got, m1)
	}
}

func TestMarkReadV2Burst_DoesNotStarveChannelFocus(t *testing.T) {
	deps, userID, chID := newFocusTestDeps(t)
	deps.Limiter = auth.NewRateLimiter()
	info := ClientInfo{UserID: userID, Username: "focuser"}

	// A "Mark All as Read" burst exhausts mark_read's own 5/s budget...
	for range 5 {
		res := handleMarkReadV2(context.Background(), MarkReadCmd{userID: userID, channelID: chID}, info, deps)
		if res.Error != nil {
			t.Fatalf("in-budget mark_read %v returned error", res.Error)
		}
	}
	markRes := handleMarkReadV2(context.Background(), MarkReadCmd{userID: userID, channelID: chID}, info, deps)
	if markRes.Error != nil {
		t.Fatalf("rate-limited mark_read returned error %v, want silent drop", markRes.Error)
	}

	// ...but must not consume any of channel_focus's separate budget: a
	// channel switch immediately after the burst still succeeds.
	focusRes := handleChannelFocusV2(context.Background(), ChannelFocusCmd{userID: userID, channelID: chID}, info, deps)
	if focusRes.SetChannelID == nil {
		t.Fatal("channel_focus after a mark_read burst must still set the channel id, not be starved by a shared budget")
	}
}

func TestChannelFocusV2_NoEvents(t *testing.T) {
	deps, userID, chID := newFocusTestDeps(t)
	cmd := ChannelFocusCmd{userID: userID, channelID: chID}
	info := ClientInfo{UserID: userID, Username: "focuser"}

	result := handleChannelFocusV2(context.Background(), cmd, info, deps)

	if len(result.Events) != 0 {
		t.Errorf("expected no events, got %d", len(result.Events))
	}
}
