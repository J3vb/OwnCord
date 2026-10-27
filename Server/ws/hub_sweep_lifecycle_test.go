package ws

import (
	"context"
	"errors"
	"github.com/J3vb/OwnCord/Server/auth"
	"sync/atomic"
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
	h.clients[c.userID] = []*Client{c}
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

type armOnLeaveStore struct {
	VoiceStore
	armed *atomic.Bool
}

func (s armOnLeaveStore) LeaveIfMatch(ctx context.Context, userID, channelID int64, joinedAt string) (bool, error) {
	deleted, err := s.VoiceStore.LeaveIfMatch(ctx, userID, channelID, joinedAt)
	s.armed.Store(true)
	return deleted, err
}

// stallAfterArmVisibility blocks GetChannel — the broadcast audience's first
// read — until its ctx ends, once armed: a DB that stalls right after a commit.
type stallAfterArmVisibility struct {
	VisibilityReader
	armed *atomic.Bool
}

func (v stallAfterArmVisibility) GetChannel(ctx context.Context, id int64) (*db.Channel, error) {
	if v.armed.Load() {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return v.VisibilityReader.GetChannel(ctx, id)
}

// The post-commit tail runs detached from the sweep's cancellation but must
// still end at sweepTailTimeout: a stalled DB cannot pin the in-flight guard
// or keep Done open.
func TestSweepStaleVoiceStates_StalledTailEndsAtTailTimeout(t *testing.T) {
	old := sweepTailTimeout
	sweepTailTimeout = 50 * time.Millisecond
	t.Cleanup(func() { sweepTailTimeout = old })

	database := newHarvestVoiceDB(t)
	ghostUID := seedHarvestVoiceUser(t, database, "tail-ghost")
	chID := mustCreateVoiceChannel(t, database, "voice-tail-stall")
	if err := database.JoinVoiceChannel(context.Background(), ghostUID, chID); err != nil {
		t.Fatalf("JoinVoiceChannel(ghost): %v", err)
	}

	h := newTestHub(t, database, auth.NewRateLimiter(), nil)
	var armed atomic.Bool
	h.voice = armOnLeaveStore{VoiceStore: h.voice, armed: &armed}
	h.readers.Visibility = stallAfterArmVisibility{VisibilityReader: h.readers.Visibility, armed: &armed}
	go h.Run()

	h.startSweep(&h.voiceSweepInFlight, h.sweepStaleVoiceStates)
	deadline := time.Now().Add(5 * time.Second)
	for !armed.Load() {
		if time.Now().After(deadline) {
			t.Fatal("sweep never committed the ghost delete")
		}
		time.Sleep(time.Millisecond)
	}
	for h.voiceSweepInFlight.Load() {
		if time.Now().After(deadline) {
			t.Fatal("stalled tail never ended: voiceSweepInFlight stayed set")
		}
		time.Sleep(time.Millisecond)
	}

	h.Stop()
	select {
	case <-h.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Done never closed after Stop")
	}
}

// A tail stalled on the DB with a long budget must still end when the hub
// stops, so Done does not outlast the shutdown step.
func TestSweepStaleVoiceStates_StalledTailEndsAtHubStop(t *testing.T) {
	old := sweepTailTimeout
	sweepTailTimeout = time.Minute
	t.Cleanup(func() { sweepTailTimeout = old })

	database := newHarvestVoiceDB(t)
	ghostUID := seedHarvestVoiceUser(t, database, "tail-stop-ghost")
	chID := mustCreateVoiceChannel(t, database, "voice-tail-stop")
	if err := database.JoinVoiceChannel(context.Background(), ghostUID, chID); err != nil {
		t.Fatalf("JoinVoiceChannel(ghost): %v", err)
	}

	h := newTestHub(t, database, auth.NewRateLimiter(), nil)
	var armed atomic.Bool
	h.voice = armOnLeaveStore{VoiceStore: h.voice, armed: &armed}
	h.readers.Visibility = stallAfterArmVisibility{VisibilityReader: h.readers.Visibility, armed: &armed}
	go h.Run()

	h.startSweep(&h.voiceSweepInFlight, h.sweepStaleVoiceStates)
	deadline := time.Now().Add(5 * time.Second)
	for !armed.Load() {
		if time.Now().After(deadline) {
			t.Fatal("sweep never committed the ghost delete")
		}
		time.Sleep(time.Millisecond)
	}

	h.Stop()
	select {
	case <-h.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Done stayed open: the stalled tail outlasted Stop")
	}
}
