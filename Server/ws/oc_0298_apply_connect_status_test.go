package ws

// oc_0298_apply_connect_status_test.go — regression test for OC-0298.
//
// applyConnectStatus (serve.go) is supposed to be the single place that
// settles the status a reconnecting/freshly-connecting session comes online
// as: it writes db.ConnectStatus(saved) to users.status and then caches that
// same value on c.user.Status, which announceConnectPresence broadcasts and
// which buildAuthOK reports back to the connecting client itself.
//
// When the DB write fails, the old code logged and swallowed the error but
// still unconditionally stamped c.user.Status to the new value — so auth_ok
// and the presence broadcast both claim a status that was never persisted.
// Every later ready payload (built via ListMembers, which reads users.status)
// disagrees with what this connected client is telling everyone else about
// itself, and nothing ever corrects it because presentableMembers only ever
// downgrades a connected user's status to offline, never upgrades one.
//
// The fix: only stamp c.user.Status when the write actually succeeded, so a
// failure leaves the in-memory value equal to whatever is actually in
// users.status.
import (
	"context"
	"testing"

	"github.com/owncord/server/db"
)

func TestApplyConnectStatus_DoesNotStampStatusWhenDBWriteFails(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "connect-status-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	// Establish a known persisted status distinct from what ConnectStatus
	// would compute from it, so a wrongly-stamped c.user.Status is
	// unambiguous. MarkUserDisconnected is what actually leaves a session at
	// "offline" going into a reconnect, so use that instead of a raw status
	// write to keep the precondition realistic.
	if err := database.UpdateUserStatus(ctx, userID, db.StatusOnline); err != nil {
		t.Fatalf("UpdateUserStatus(online): %v", err)
	}
	if err := database.MarkUserDisconnected(ctx, userID); err != nil {
		t.Fatalf("MarkUserDisconnected: %v", err)
	}
	pre, err := database.GetUserByID(ctx, userID)
	if err != nil || pre == nil {
		t.Fatalf("GetUserByID (precondition): %v", err)
	}
	if pre.Status != db.StatusOffline {
		t.Fatalf("precondition: expected status=offline after MarkUserDisconnected, got %q", pre.Status)
	}

	c := newClient(nil, nil, pre, "tokenhash", 0, ctx)

	// A canceled context makes the UpdateUserStatus write fail deterministically
	// (database/sql refuses to start an exec against an already-canceled
	// context) without needing a mock DB — applyConnectStatus takes a
	// concrete *db.DB, not an interface.
	failCtx, cancel := context.WithCancel(ctx)
	cancel()

	applyConnectStatus(failCtx, database, c)

	if c.user.Status != db.StatusOffline {
		t.Fatalf("c.user.Status = %q after a failed UpdateUserStatus, want unchanged %q — "+
			"applyConnectStatus must not stamp a new status that was never persisted "+
			"(auth_ok and the presence broadcast would otherwise claim a value "+
			"users.status disagrees with)",
			c.user.Status, db.StatusOffline)
	}

	post, err := database.GetUserByID(ctx, userID)
	if err != nil || post == nil {
		t.Fatalf("GetUserByID (postcondition): %v", err)
	}
	if post.Status != db.StatusOffline {
		t.Fatalf("persisted status after failed applyConnectStatus = %q, want unchanged %q", post.Status, db.StatusOffline)
	}
}
