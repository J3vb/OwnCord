package ws

// Internal test for OC-0211: handleMessageSessionRecheck must not treat a
// transient DB error the same as a genuinely revoked/expired session. The
// sibling sweep in hub_sweep.go (sweepRevokedSessions) already documents and
// implements the correct rule for the identical failure: "a failed batch
// lookup says nothing about any individual session — kicking everyone on a
// transient DB error would be a mass disconnect. Skip this sweep; the next
// tick retries." handleMessageSessionRecheck disagreed, kicking the client on
// dbErr != nil exactly like a deleted/expired session.

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestHandleMessageSessionRecheck_TransientDBErrorDoesNotKick(t *testing.T) {
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "recheck-dberr")

	tokenHash := "tok-recheck-dberr"
	if _, err := database.CreateSession(context.Background(), uid, tokenHash, "test-device", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	h := newTestHub(t, database, auth.NewRateLimiter(), nil)
	c := NewTestClient(h, uid, make(chan []byte, 8))
	c.tokenHash = tokenHash
	// Put the client one message away from the periodic recheck boundary, so
	// the very next call to handleMessageSessionRecheck triggers the DB read.
	c.msgCount = SessionCheckInterval - 1
	h.clients[uid] = c

	// Force GetSessionWithBanStatus to fail with a genuine DB error (not
	// sql.ErrNoRows, which the production code already treats as "session
	// gone" — that path is not in question here). Closing the underlying
	// connection pool reproduces the same dbErr != nil branch a transient
	// SQLITE_BUSY, I/O error, or maintenance window would.
	if err := database.Close(); err != nil {
		t.Fatalf("database.Close: %v", err)
	}

	closed := h.handleMessageSessionRecheck(c)

	if closed {
		t.Fatalf("handleMessageSessionRecheck reported the connection closed on a transient DB lookup error; " +
			"a failed read is not evidence the session is invalid (compare sweepRevokedSessions, which skips on the same failure)")
	}

	h.mu.RLock()
	_, stillConnected := h.clients[uid]
	h.mu.RUnlock()
	if !stillConnected {
		t.Fatalf("client was removed from h.clients on a transient DB lookup error during session recheck")
	}
	if c.isSendClosed() {
		t.Fatalf("client's send channels were closed on a transient DB lookup error during session recheck")
	}
}
