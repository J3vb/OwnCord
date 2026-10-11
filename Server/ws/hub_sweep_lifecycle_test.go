package ws

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// blockingSweepAuthn is a SocketAuthenticator whose session sweep holds until
// its ctx ends — a wedged DB — signalling entered and reporting how it ended.
type blockingSweepAuthn struct {
	partialSweepAuthn
	entered chan struct{}
	ended   chan error
}

func (a blockingSweepAuthn) SweepSessions(ctx context.Context, _ []string) (map[string]service.SessionVerdict, error) {
	close(a.entered)
	<-ctx.Done()
	a.ended <- ctx.Err()
	return nil, ctx.Err()
}

// newBlockedSweepHub builds a hub with one session-bearing client, so
// sweepRevokedSessions reaches the blocking SweepSessions call.
func newBlockedSweepHub(t *testing.T) (*Hub, blockingSweepAuthn) {
	t.Helper()
	authn := blockingSweepAuthn{entered: make(chan struct{}), ended: make(chan error, 1)}
	h := newTestHubWith(t, HubOptions{DB: newHarvestVoiceDB(t), Auth: authn})
	c := newClient(h, nil, &db.User{ID: 1, Username: "sweep"}, "hash-sweep", 0, context.Background())
	h.clients[c.userID] = c
	return h, authn
}

func waitEntered(t *testing.T, entered <-chan struct{}) {
	t.Helper()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("sweep never reached SweepSessions")
	}
}

// Stop during a sweep blocked on the store must interrupt that sweep, and
// Done must not report the hub gone while the sweep is still running —
// whoever waits on Done goes on to close the DB the sweep is reading.
func TestHubStop_CancelsBlockedSweepAndDoneWaitsForIt(t *testing.T) {
	h, authn := newBlockedSweepHub(t)
	go h.Run()

	h.startSweep(&h.sessionSweepInFlight, h.sweepRevokedSessions)
	waitEntered(t, authn.entered)

	h.Stop()
	select {
	case <-h.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Done never closed after Stop during a blocked sweep")
	}

	select {
	case err := <-authn.ended:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("sweep ended with %v, want context.Canceled from Stop", err)
		}
	default:
		t.Fatal("Done closed while the sweep was still blocked: Stop did not cancel it, or Done did not wait for it")
	}
}

// A sweep blocked on the store while the hub keeps running must give up at
// sweepTimeout, freeing its in-flight guard for the next tick.
func TestStartSweep_BlockedSweepEndsAtSweepTimeout(t *testing.T) {
	old := sweepTimeout
	sweepTimeout = 20 * time.Millisecond
	t.Cleanup(func() { sweepTimeout = old })

	h, authn := newBlockedSweepHub(t)
	h.startSweep(&h.sessionSweepInFlight, h.sweepRevokedSessions)
	waitEntered(t, authn.entered)

	select {
	case err := <-authn.ended:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("sweep ended with %v, want context.DeadlineExceeded", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("blocked sweep never ended: its ctx has no deadline")
	}
	for h.sessionSweepInFlight.Load() {
		time.Sleep(time.Millisecond)
	}
}
