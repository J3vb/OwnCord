package ws

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// partialSweepAuthn is a SocketAuthenticator whose sweep answers only the
// hashes it was configured with. Nothing in the interface contract requires
// the returned map to be total, so this is a legal implementation — what a
// missing answer means is the consumer's to decide, and the test below pins
// that decision.
type partialSweepAuthn struct {
	verdicts map[string]service.SessionVerdict
}

func (a partialSweepAuthn) ResolveSocketPrincipal(context.Context, string) (*db.User, error) {
	return nil, errors.New("not used by the sweep")
}

func (a partialSweepAuthn) SweepSessions(context.Context, []string) (map[string]service.SessionVerdict, error) {
	return a.verdicts, nil
}

func (a partialSweepAuthn) RecordSocketConnect(context.Context, int64, string) {}

// TestSweepRevokedSessions_MissingVerdictFailsClosed pins the sweep's posture
// for a session the authenticator did not answer for: kick, exactly as the
// pre-seam code kicked on a missing batch row. A missing map entry reads as
// SessionVerdict's zero value, so this test is what keeps that zero value
// fail-closed — reorder the constants and it goes red.
func TestSweepRevokedSessions_MissingVerdictFailsClosed(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	h := newTestHubWith(t, HubOptions{
		DB: database,
		Auth: partialSweepAuthn{verdicts: map[string]service.SessionVerdict{
			"hash-answered-live": service.SessionLive,
		}},
	})

	ctx := context.Background()
	answered := newClient(h, nil, &db.User{ID: 1, Username: "answered"}, "hash-answered-live", 0, ctx)
	unanswered := newClient(h, nil, &db.User{ID: 2, Username: "unanswered"}, "hash-nobody-answered-for", 0, ctx)
	h.clients[answered.userID] = answered
	h.clients[unanswered.userID] = unanswered

	h.sweepRevokedSessions()

	h.mu.RLock()
	_, answeredStays := h.clients[answered.userID]
	_, unansweredStays := h.clients[unanswered.userID]
	h.mu.RUnlock()

	if !answeredStays {
		t.Error("a session the authenticator answered SessionLive for must stay connected")
	}
	if unansweredStays {
		t.Error("a session the authenticator did not answer for must be kicked (fail closed), not silently kept")
	}
}
