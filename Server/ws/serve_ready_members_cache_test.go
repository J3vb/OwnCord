package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// DP-37: a restart herd builds hundreds of ready payloads at once, and each
// used to run its own ListMembers. The member list is now one shared read,
// reused until the member generation moves or a temporary ban lapses. These
// tests pin both halves: the herd shares the read, and the share never hides
// a committed join, ban or lapse.

// countingReader counts ListMembers calls. When hold is non-nil, the first
// call signals entered and then waits on hold before reading, so a test can
// commit a write while that read is in flight.
type countingReader struct {
	*db.DB
	lists   atomic.Int32
	entered chan struct{}
	hold    chan struct{}
}

func (r *countingReader) ListMembers(ctx context.Context) ([]db.MemberSummary, error) {
	if r.lists.Add(1) == 1 && r.hold != nil {
		close(r.entered)
		<-r.hold
	}
	return r.DB.ListMembers(ctx)
}

func buildReadyMembers(t *testing.T, hub *ws.Hub, reader ws.ReadySnapshotReader, viewerID int64) map[int64]map[string]any {
	t.Helper()
	raw, err := hub.BuildReadyWithReaderForTest(reader, viewerID)
	if err != nil {
		t.Fatalf("buildReady(%d): %v", viewerID, err)
	}
	return readyMembers(t, raw)
}

func TestReadyMembers_ConcurrentReadiesShareOneRead(t *testing.T) {
	hub, database := newTestHub(t)
	const n = 50
	viewers := make([]*db.User, n)
	for i := range n {
		viewers[i] = seedOwnerUser(t, database, fmt.Sprintf("herd-%d", i))
	}
	reader := &countingReader{DB: database}

	start := make(chan struct{})
	var wg sync.WaitGroup
	payloads := make([][]byte, n)
	errs := make([]error, n)
	for i := range n {
		wg.Go(func() {
			<-start
			payloads[i], errs[i] = hub.BuildReadyWithReaderForTest(reader, viewers[i].ID)
		})
	}
	close(start)
	wg.Wait()

	for i := range n {
		if errs[i] != nil {
			t.Fatalf("buildReady(%d): %v", i, errs[i])
		}
		if got := len(readyMembers(t, payloads[i])); got != n {
			t.Fatalf("ready %d carries %d members, want %d", i, got, n)
		}
	}
	if got := reader.lists.Load(); got != 1 {
		t.Errorf("%d concurrent ready payloads ran %d ListMembers reads, want 1", n, got)
	}
}

func TestReadyMembers_JoinBetweenReadiesIsVisible(t *testing.T) {
	hub, database := newTestHub(t)
	viewer := seedOwnerUser(t, database, "viewer")
	reader := &countingReader{DB: database}

	if _, ok := buildReadyMembers(t, hub, reader, viewer.ID)[viewer.ID]; !ok {
		t.Fatal("viewer missing from their own ready")
	}
	joiner := seedOwnerUser(t, database, "joiner")
	if _, ok := buildReadyMembers(t, hub, reader, viewer.ID)[joiner.ID]; !ok {
		t.Error("a member who joined after the previous ready is missing from the next one")
	}
}

func TestReadyMembers_LapsedTemporaryBanReappears(t *testing.T) {
	hub, database := newTestHub(t)
	viewer := seedOwnerUser(t, database, "viewer")
	banned := seedOwnerUser(t, database, "tempbanned")
	// Whole seconds: ban_expires is stored and compared at second precision.
	expires := time.Now().UTC().Truncate(time.Second).Add(2 * time.Second)
	if err := database.BanUser(context.Background(), banned.ID, "cool off", &expires); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
	reader := &countingReader{DB: database}

	if _, ok := buildReadyMembers(t, hub, reader, viewer.ID)[banned.ID]; ok {
		t.Fatal("a member under a live temporary ban is in the ready payload")
	}
	// No write marks the lapse, so nothing bumps the generation: only the
	// cached list's own expiry can let the member back in.
	time.Sleep(time.Until(expires) + 1100*time.Millisecond)
	if _, ok := buildReadyMembers(t, hub, reader, viewer.ID)[banned.ID]; !ok {
		t.Error("a member whose temporary ban lapsed is still missing from ready (OC-0023)")
	}
}

func TestReadyMembers_BanDuringInFlightReadIsNotServed(t *testing.T) {
	hub, database := newTestHub(t)
	viewer := seedOwnerUser(t, database, "viewer")
	target := seedOwnerUser(t, database, "target")
	reader := &countingReader{DB: database, entered: make(chan struct{}), hold: make(chan struct{})}

	// Handshake A starts the shared read and stalls inside it.
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		_, _ = hub.BuildReadyWithReaderForTest(reader, viewer.ID)
	}()
	<-reader.entered

	// The ban commits while A's read is still open, and handshake B starts
	// after it: B must not join or reuse A's pre-ban result.
	if err := database.BanUser(context.Background(), target.ID, "gone", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
	second := make(chan []byte, 1)
	go func() {
		raw, err := hub.BuildReadyWithReaderForTest(reader, viewer.ID)
		if err != nil {
			t.Errorf("buildReady(B): %v", err)
		}
		second <- raw
	}()

	var rawB []byte
	select {
	case rawB = <-second:
	case <-time.After(5 * time.Second):
		close(reader.hold)
		t.Fatal("handshake B waited on handshake A's pre-ban read")
	}
	close(reader.hold)
	<-firstDone
	if _, ok := readyMembers(t, rawB)[target.ID]; ok {
		t.Error("a ban committed during a handshake was served from the stale in-flight read (OC-0272)")
	}
	// A's late pre-ban result must not overwrite the newer one either.
	if _, ok := buildReadyMembers(t, hub, reader, viewer.ID)[target.ID]; ok {
		t.Error("the stale pre-ban read replaced the post-ban cached list")
	}
}

// users.status is not part of the generation (every connect writes it), so a
// cached list carries whatever status the row held at the read. The live
// status the hub stamped must win for a connected member, or a user who
// connects after the read shows offline to everyone who connects later
// (OC-0019's symptom, reached a different way).
func TestReadyMembers_ConnectAfterCachedReadShowsLiveStatus(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)
	viewer := seedOwnerUser(t, database, "viewer")
	late := seedOwnerUser(t, database, "late")
	reader := &countingReader{DB: database}

	if got := buildReadyMembers(t, hub, reader, viewer.ID)[late.ID]["status"]; got != db.StatusOffline {
		t.Fatalf("late before connecting = %v, want offline", got)
	}
	lc := ws.NewTestClientWithUser(hub, late, 0, make(chan []byte, 16))
	hub.Register(lc)
	waitRegistered(t, hub, lc)
	hub.ApplyConnectStatusForTest(lc)

	if got := buildReadyMembers(t, hub, reader, viewer.ID)[late.ID]["status"]; got != db.StatusOnline {
		t.Errorf("late after connecting = %v, want online", got)
	}
	if got := reader.lists.Load(); got != 1 {
		t.Errorf("a connect stamp forced %d ListMembers reads, want 1 (status must not move the generation)", got)
	}
}

func TestReadyMembers_PresenceUpdateAfterCachedReadShowsLiveStatus(t *testing.T) {
	// The coverage hub carries the service layer the presence handler needs.
	hub, database := newCoverageHub(t)
	viewer := seedCoverageOwner(t, database, "viewer")
	busy := seedCoverageOwner(t, database, "busy")
	bc := ws.NewTestClientWithUser(hub, busy, 0, make(chan []byte, 16))
	hub.Register(bc)
	waitRegistered(t, hub, bc)
	hub.ApplyConnectStatusForTest(bc)
	reader := &countingReader{DB: database}

	if got := buildReadyMembers(t, hub, reader, viewer.ID)[busy.ID]["status"]; got != db.StatusOnline {
		t.Fatalf("busy before presence_update = %v, want online", got)
	}
	raw, _ := json.Marshal(map[string]any{
		"type":    "presence_update",
		"payload": map[string]any{"status": db.StatusDND},
	})
	hub.HandleMessageForTest(bc, raw)

	if got := buildReadyMembers(t, hub, reader, viewer.ID)[busy.ID]["status"]; got != db.StatusDND {
		t.Errorf("busy after presence_update = %v, want dnd", got)
	}
}
