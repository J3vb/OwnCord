package service

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// Revocation deletes the session row directly and never waits on the batched
// touch (#2049 batches it in memory, P5-S07). A touch queued before that
// delete is still pending when it lands; it must not resurrect the row or
// leave it valid, because a revoked session a queued touch could bring back
// would defeat the revoke.
func TestConnWrites_QueuedTouchDoesNotReviveARevokedSession(t *testing.T) {
	database, spy, w, sessions, _ := newBatchedServices(t)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 1, Username: "revoked"})
	if _, err := database.CreateSession(ctx, 1, "tok", "dev", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if err := sessions.TouchSession(ctx, "tok"); err != nil {
		t.Fatalf("TouchSession: %v", err)
	}
	if spy.touchCalls != 0 {
		t.Fatalf("the touch wrote immediately (%d statements), want it queued", spy.touchCalls)
	}

	// The session is revoked while the touch is still pending.
	if err := database.DeleteSession(ctx, "tok"); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	sess, err := database.GetSessionByTokenHash(ctx, "tok")
	if err != nil {
		t.Fatalf("GetSessionByTokenHash: %v", err)
	}
	if sess != nil {
		t.Fatalf("session = %v after the flush; a queued touch revived a revoked session", sess)
	}
}
