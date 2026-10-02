package ws

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// A password change or a single-session revoke removes some of an account's
// sessions. The account's socket goes at once when its own session was among
// them, and stays when it rode the session that was kept.
func TestDisconnectIfSessionRevoked_KicksOnlyARevokedSessionsSocket(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	ctx := context.Background()
	uid, err := database.CreateUser(ctx, "changer", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	keep, err := database.CreateSession(ctx, uid, "hash-kept", "laptop", "10.0.0.1")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := database.CreateSession(ctx, uid, "hash-other", "phone", "10.0.0.2"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	h := newTestHubWith(t, HubOptions{DB: database})
	connected := func() bool {
		h.mu.RLock()
		defer h.mu.RUnlock()
		_, ok := h.clients[uid]
		return ok
	}

	// The socket rides the kept session: it stays.
	h.clients[uid] = newClient(h, nil, &db.User{ID: uid, Username: "changer"}, "hash-kept", 0, ctx)
	if _, err := database.DeleteOtherSessions(ctx, uid, keep); err != nil {
		t.Fatalf("DeleteOtherSessions: %v", err)
	}
	h.DisconnectIfSessionRevoked(uid)
	if !connected() {
		t.Fatal("the socket on the kept session was kicked")
	}

	// The socket rides a revoked session: it goes now, not at the next sweep.
	h.clients[uid] = newClient(h, nil, &db.User{ID: uid, Username: "changer"}, "hash-other", 0, ctx)
	h.DisconnectIfSessionRevoked(uid)
	if connected() {
		t.Fatal("the socket on a revoked session is still connected")
	}
}
