package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.uber.org/goleak"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// A reconnect of an affected user while its refresh is pending takes a full
// ready built from post-commit permissions (edge case 2); another user
// resuming at the same time is served by replay.
func TestRoleRefresh_ResumeWhilePendingTakesFullReady(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()
	mk := func(name string) (int64, string) {
		id, err := database.CreateUser(ctx, name, "hash", rrMemberRole)
		if err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		token, err := auth.GenerateToken()
		if err != nil {
			t.Fatalf("GenerateToken: %v", err)
		}
		if _, err := database.CreateSession(ctx, id, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
		return id, token
	}
	affected, affToken := mk("rr-resume-aff")
	_, otherToken := mk("rr-resume-other")
	chID, err := database.CreateChannel(ctx, "rr-resume", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	hub.perms = service.NewPermissionService(database, permissions.NewChecker(database))
	go hub.Run()
	t.Cleanup(hub.Stop)
	rb := hub.ReplayBuffer()
	for seq := uint64(96); seq <= 98; seq++ {
		rb.Push(seq, chID, []byte(`{"seq":`+itoaTest(int64(seq))+`,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"x"}}`))
	}
	hub.SeedSeq(98)

	// The worker is held right after it took the pending work.
	roundEntered := make(chan struct{})
	roundRelease := make(chan struct{})
	gate := func() {
		close(roundEntered)
		<-roundRelease
	}
	hub.roleRefresh.gate.Store(&gate)
	t.Cleanup(func() {
		select {
		case <-roundRelease:
		default:
			close(roundRelease)
		}
	})

	hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{affected}})
	select {
	case <-roundEntered:
	case <-time.After(10 * time.Second):
		t.Fatal("the worker never started its round")
	}
	// Move the seq past the enqueue-time watermark, so only the pending
	// refresh (covers) can force the affected user onto a full ready.
	hub.BroadcastToAll(buildMemberUpdate(1, "x", nil))
	hub.BroadcastToAll(buildMemberUpdate(1, "y", nil))
	rrWaitFor(t, "the seq to pass the watermark", func() bool {
		return atomic.LoadUint64(&hub.seq) >= 100
	})

	hasReady := func(frames [][]byte) bool {
		for _, fr := range frames {
			if strings.Contains(string(fr), `"type":"ready"`) {
				return true
			}
		}
		return false
	}
	if !hasReady(dialAndResume(t, hub, affToken, 99)) {
		t.Error("the affected user, with its refresh pending, resumed by replay instead of a full ready")
	}
	if hasReady(dialAndResume(t, hub, otherToken, 99)) {
		t.Error("an unaffected user was forced onto a full ready by someone else's refresh")
	}
}

// Stop mid-round: the worker is joined by finishRun, whatever is pending is
// dropped, and nothing leaks.
func TestRoleRefresh_StopJoinsWorkerAndDropsPending(t *testing.T) {
	defer goleak.VerifyNone(t, goleak.IgnoreCurrent(), goleak.IgnoreTopFunction("database/sql.(*DB).connectionOpener"))
	f := newRRFixture(t, false)
	a := f.addUser("rr-stop-a", rrModRole, 0)
	b := f.addUser("rr-stop-b", rrModRole, 0)
	entered, release := gateOnce(f.hub)
	defer release()
	go f.hub.Run()

	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{a}})
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("round never started")
	}
	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{b}})
	f.hub.Stop()
	select {
	case <-f.hub.Done():
		t.Fatal("Done closed while the worker is still mid-round")
	case <-time.After(50 * time.Millisecond):
	}
	release()
	select {
	case <-f.hub.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("Done never closed: the worker was not joined")
	}
	if got := channelFrames(f.drainFrames(b)); len(got) != 0 {
		t.Errorf("a refresh pending at stop was sent anyway: %v", got)
	}
}

// A client that does not drain between chunks is kicked, never sent BANNED.
func TestRoleRefresh_SlowClientIsKickedNotBanned(t *testing.T) {
	f := newRRFixture(t, false)
	u := f.addUser("rr-slow", rrModRole, 0)
	send := make(chan []byte, 128)
	c := NewTestClientWithUser(f.hub, f.clients[u].user, 0, send)
	f.hub.mu.Lock()
	f.hub.clients[u] = []*Client{c}
	f.hub.mu.Unlock()
	for range 70 { // above a quarter of sendBufSize: it never drains
		send <- []byte(`{"type":"filler"}`)
	}
	oldChunk, oldWait := roleRefreshChunk, roleRefreshDrainWait
	roleRefreshChunk, roleRefreshDrainWait = 2, 20*time.Millisecond
	t.Cleanup(func() { roleRefreshChunk, roleRefreshDrainWait = oldChunk, oldWait })

	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{u}})
	f.hub.flushRoleRefresh(context.Background())

	if f.hub.ClientForTest(u) != nil {
		t.Error("the slow client is still registered, want it kicked")
	}
	for fr := range send {
		if strings.Contains(string(fr), "BANNED") {
			t.Fatalf("a kicked client was sent BANNED: %s", fr)
		}
	}
}

type failingRoleReader struct{ DispatchReader }

func (failingRoleReader) GetMemberRoles(context.Context, int64) (*db.MemberRoles, error) {
	return nil, errors.New("role lookup down")
}

// A user whose permissions cannot be resolved is kicked (it reconnects onto a
// full ready), never sent BANNED and never left with stale subscriptions.
func TestRoleRefresh_UnresolvedSubjectKicks(t *testing.T) {
	f := newRRFixture(t, false)
	f.hub.perms = nil // the bare-hub branch reads the Dispatch reader
	f.hub.readers.Dispatch = failingRoleReader{f.hub.readers.Dispatch}
	u := f.addUser("rr-unresolved", rrModRole, f.chA)
	bystander := f.addUser("rr-unresolved-by", rrModRole, 0)

	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{u}})
	f.hub.flushRoleRefresh(context.Background())

	if f.hub.ClientForTest(u) != nil {
		t.Error("a user whose permissions could not be resolved was not kicked")
	}
	if f.hub.ClientForTest(bystander) == nil {
		t.Error("an unaffected user was kicked")
	}
	for fr := range f.sends[u] {
		if strings.Contains(string(fr), "BANNED") {
			t.Fatalf("an unresolved user was sent BANNED: %s", fr)
		}
	}
}

// 300 holders renamed at once: the member_updates are paced in batches so none
// is dropped, and every client receives all of them, in order, carrying the
// name read when the round ran.
func TestRoleRefresh_MemberUpdatesPacedInOrder(t *testing.T) {
	f := newRRFixture(t, true)
	obs1 := f.addUser("rr-obs-1", rrModRole, 0)
	obs2 := f.addUser("rr-obs-2", rrModRole, 0)
	ctx := context.Background()
	const m = 300
	ids := make([]int64, 0, m)
	for i := range m {
		id, err := f.database.CreateUser(ctx, fmt.Sprintf("rr-holder-%03d", i), "hash", rrMemberRole)
		if err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		ids = append(ids, id)
	}
	roundEntered, roundRelease := make(chan struct{}), make(chan struct{})
	gate := func() {
		close(roundEntered)
		<-roundRelease
	}
	f.hub.roleRefresh.gate.Store(&gate)
	t.Cleanup(func() {
		select {
		case <-roundRelease:
		default:
			close(roundRelease)
		}
	})

	// Enqueued under the old name; renamed while the round is held, so only a
	// name read at run time yields the new one.
	f.hub.EnqueueRoleRefresh(RoleRefresh{MemberUpdate: ids})
	<-roundEntered
	if _, err := f.database.ExecContext(ctx, `UPDATE roles SET name = 'Regulars' WHERE id = ?`, rrMemberRole); err != nil {
		t.Fatalf("rename: %v", err)
	}
	f.hub.perms.InvalidateAll()
	close(roundRelease)
	waitRoleRefreshIdle(t, f.hub)

	for _, obs := range []int64{obs1, obs2} {
		var got []int64
		rrWaitFor(t, "all member_updates", func() bool {
			for _, fr := range f.drainFrames(obs) {
				if fr.Type != MsgTypeMemberUpdate {
					continue
				}
				if fr.Role != "Regulars" {
					t.Errorf("member_update for %d carries %q, want the run-time name", fr.UID, fr.Role)
				}
				got = append(got, fr.UID)
			}
			return len(got) >= m
		})
		if !slices.Equal(got, ids) {
			t.Errorf("observer %d received member_updates out of order or incomplete (%d of %d)", obs, len(got), m)
		}
	}
	if d := f.hub.broadcastDrops.Load(); d != 0 {
		t.Errorf("broadcastDrops = %d, want 0 with the updates paced", d)
	}
}

// Two edits racing: whichever commit lands last, the final roles_update equals
// the database, because one goroutine reads and enqueues in order.
func TestRoleRefresh_RolesUpdateFollowsLastCommit(t *testing.T) {
	f := newRRFixture(t, true)
	obs := f.addUser("rr-roles-obs", rrModRole, 0)
	ctx := context.Background()
	done := make(chan struct{}, 2)
	for i := range 2 {
		go func() {
			defer func() { done <- struct{}{} }()
			for j := range 10 {
				name := fmt.Sprintf("Racer-%d-%d", i, j)
				if _, err := f.database.ExecContext(ctx, `UPDATE roles SET name = ? WHERE id = ?`, name, rrMemberRole); err != nil {
					t.Errorf("rename: %v", err)
					return
				}
				f.hub.EnqueueRoleRefresh(RoleRefresh{Roles: true})
			}
		}()
	}
	<-done
	<-done
	waitRoleRefreshIdle(t, f.hub)
	want := roleName(t, f.database, rrMemberRole)

	var last []string
	rrWaitFor(t, "the final roles_update", func() bool {
		for _, raw := range drainChan(f.sends[obs], 60*time.Millisecond) {
			var env struct {
				Type    string `json:"type"`
				Payload struct {
					Roles []struct {
						ID   int64  `json:"id"`
						Name string `json:"name"`
					} `json:"roles"`
				} `json:"payload"`
			}
			if json.Unmarshal(raw, &env) != nil || env.Type != MsgTypeRolesUpdate {
				continue
			}
			last = last[:0]
			for _, r := range env.Payload.Roles {
				if r.ID == rrMemberRole {
					last = append(last, r.Name)
				}
			}
		}
		return len(last) == 1 && last[0] == want
	})
}

// A channel created after the round's snapshot and held by the user is
// resolved now: kept and sent when the user may view it, released otherwise.
func TestRoleRefresh_HeldChannelOutsideSnapshotIsResolved(t *testing.T) {
	f := newRRFixture(t, false)
	ctx := context.Background()
	viewer := f.addUser("rr-snap-mod", rrModRole, f.chA)
	denied := f.addUser("rr-snap-member", rrMemberRole, f.chA)

	frames, allowed, ok := f.hub.roleRefreshVerdicts(ctx, viewer, &roleChannels{})
	if !ok || !allowed[f.chA] {
		t.Fatalf("held channel missing from the keep set: ok=%v allowed=%v", ok, allowed)
	}
	if len(frames) != 1 || frames[0].channelID != f.chA || frames[0].remove {
		t.Errorf("frames = %+v, want one channel_create for the held channel", frames)
	}

	frames, allowed, ok = f.hub.roleRefreshVerdicts(ctx, denied, &roleChannels{})
	if !ok || allowed[f.chA] || len(frames) != 0 {
		t.Errorf("a member who cannot view the channel: ok=%v allowed=%v frames=%+v, want it released", ok, allowed, frames)
	}
}

type listFailingReader struct {
	VisibilityReader
	failures atomic.Int32 // remaining ListChannels calls to fail
}

func (r *listFailingReader) ListChannels(ctx context.Context) ([]db.Channel, error) {
	if r.failures.Add(-1) >= 0 {
		return nil, errors.New("channel list down")
	}
	return r.VisibilityReader.ListChannels(ctx)
}

// A failed channel list puts the round back and retries; the users are closed
// only after roleRefreshListAttempts consecutive failures.
func TestRoleRefresh_ListFailureRetriesThenCloses(t *testing.T) {
	f := newRRFixture(t, false)
	ctx := context.Background()
	u := f.addUser("rr-list", rrModRole, f.chA)
	rd := &listFailingReader{VisibilityReader: f.hub.readers.Visibility}
	rd.failures.Store(100)
	f.hub.readers.Visibility = rd

	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{u}})
	for i := 1; i < roleRefreshListAttempts; i++ {
		if d := f.hub.flushRoleRefresh(ctx); d <= 0 {
			t.Fatalf("attempt %d: no retry requested", i)
		}
		if f.hub.ClientForTest(u) == nil {
			t.Fatalf("attempt %d: user closed before the attempts ran out", i)
		}
		if !f.hub.roleRefresh.covers(u) {
			t.Fatalf("attempt %d: user not pending while the round waits to retry", i)
		}
	}
	if d := f.hub.flushRoleRefresh(ctx); d != 0 {
		t.Errorf("final attempt requested another retry (%v)", d)
	}
	if f.hub.ClientForTest(u) != nil {
		t.Error("the user was not closed after the last failed attempt")
	}
	if f.hub.roleRefresh.covers(u) {
		t.Error("user still pending after being closed")
	}
}

func TestRoleRefresh_ListFailureRecovers(t *testing.T) {
	f := newRRFixture(t, false)
	ctx := context.Background()
	u := f.addUser("rr-list-ok", rrModRole, f.chA)
	rd := &listFailingReader{VisibilityReader: f.hub.readers.Visibility}
	rd.failures.Store(1)
	f.hub.readers.Visibility = rd

	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{u}})
	if d := f.hub.flushRoleRefresh(ctx); d <= 0 {
		t.Fatal("first attempt did not ask to retry")
	}
	if d := f.hub.flushRoleRefresh(ctx); d != 0 {
		t.Fatalf("second attempt asked to retry again (%v)", d)
	}
	if f.hub.ClientForTest(u) == nil {
		t.Error("user closed although the second attempt succeeded")
	}
	if len(channelFrames(f.drainFrames(u))) == 0 {
		t.Error("no channel frames after the retry succeeded")
	}
}

// Every member's held topics are released before any member's frames are sent:
// while user 1's send is held, user 2's lost topic is already unsubscribed.
func TestRoleRefresh_RevocationNeverWaitsBehindAnotherUsersSend(t *testing.T) {
	f := newRRFixture(t, false)
	u1 := f.addUser("rr-two-pass-1", rrMemberRole, f.chA)
	u2 := f.addUser("rr-two-pass-2", rrMemberRole, f.chA)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	g := func(int64) {
		once.Do(func() {
			close(entered)
			<-release
		})
	}
	f.hub.roleRefresh.sendGate.Store(&g)
	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{u1, u2}})
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.hub.flushRoleRefresh(context.Background())
	}()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the send pass never started")
	}
	for _, uid := range []int64{u1, u2} {
		if slices.Contains(f.hub.pubsub.TopicsForUser(uid), ChannelTopic(f.chA)) {
			t.Errorf("user %d still holds the channel topic while the first send is held", uid)
		}
	}
	close(release)
	<-done
}

// A topic subscribed after the verdicts were read is judged on its own: the
// revocation leaves it alone and sends no channel_delete for it.
func TestRevokeTopicsNotIn_SkipsTopicsOutsideSnapshot(t *testing.T) {
	f := newRRFixture(t, false)
	u := f.addUser("rr-snapshot-skip", rrMemberRole, f.chA)
	known := map[int64]struct{}{f.chA: {}}
	revoked, ok := f.hub.revokeTopicsNotIn(context.Background(), u, map[int64]bool{}, known)
	if !ok || len(revoked) != 1 {
		t.Fatalf("revoked=%v ok=%v, want just the snapshot channel", revoked, ok)
	}
	f.hub.pubsub.Subscribe(f.clients[u], ChannelTopic(f.chB))
	revoked, ok = f.hub.revokeTopicsNotIn(context.Background(), u, map[int64]bool{}, known)
	if !ok || len(revoked) != 0 {
		t.Errorf("revoked=%v, want the late topic left alone", revoked)
	}
	if !slices.Contains(f.hub.pubsub.TopicsForUser(u), ChannelTopic(f.chB)) {
		t.Error("the late topic was unsubscribed")
	}
}

// A role delete's member_update carries the fallback role's name.
func TestRoleRefresh_DeleteMemberUpdateCarriesFallbackName(t *testing.T) {
	f := newRRFixture(t, true)
	ctx := context.Background()
	if _, err := f.database.ExecContext(ctx,
		`INSERT INTO roles (id, name, permissions, position, is_default) VALUES (9, 'doomed', 0, 10, 0)`); err != nil {
		t.Fatalf("seed role: %v", err)
	}
	holder := f.addUser("rr-doomed-holder", 9, 0)
	obs := f.addUser("rr-doomed-obs", rrModRole, 0)
	if _, err := f.database.DeleteRoleReassigning(ctx, 9, rrMemberRole); err != nil {
		t.Fatalf("DeleteRoleReassigning: %v", err)
	}
	f.hub.perms.InvalidateAll()
	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{holder}, MemberUpdate: []int64{holder}, Roles: true})

	want := roleName(t, f.database, rrMemberRole)
	if want != "Member" {
		t.Fatalf("fallback role name = %q, want Member", want)
	}
	rrWaitFor(t, "the member_update", func() bool {
		for _, fr := range f.drainFrames(obs) {
			if fr.Type == MsgTypeMemberUpdate && fr.UID == holder {
				if fr.Role != want {
					t.Errorf("member_update role = %q, want %q", fr.Role, want)
				}
				return true
			}
		}
		return false
	})
}

// A round that settles a user between the coverage read and the watermark
// read of a register check cannot let the reconnect through: coverage is read
// first, so the check sees either the user still covered or the new watermark.
func TestRoleRefresh_RegisterCheckReadsCoverageBeforeWatermark(t *testing.T) {
	f := newRRFixture(t, false)
	const uid = int64(77)
	f.hub.SeedSeq(100)
	s := &f.hub.roleRefresh
	s.mu.Lock()
	s.inFlight = map[int64]roleRefreshFlags{uid: rrVisibility}
	s.mu.Unlock()
	if f.hub.mustFullResync(100) {
		t.Fatal("precondition: the watermark must not force a resync yet")
	}
	fired := false
	mustFullResyncMidReadRaceHook = func() {
		fired = true
		// The round's settle: watermark bump, then done.
		f.hub.bumpVisibilityWatermark()
		s.done(uid)
	}
	t.Cleanup(func() { mustFullResyncMidReadRaceHook = nil })

	if !f.hub.mustFullResyncAtRegister(100, uid, "") {
		t.Error("a reconnect that raced the settle of its own refresh resumed by replay")
	}
	if !fired {
		t.Fatal("the hook never fired")
	}
}

// A client whose queue sits above room-for-two-chunks waits for it to drain
// before the first chunk, so frames dispatch pushes meanwhile still fit.
func TestRoleRefresh_FirstChunkLeavesRoomForConcurrentDispatch(t *testing.T) {
	f := newRRFixture(t, true)
	ctx := context.Background()
	for i := range 58 { // 60 channels in all: one chunk of sidebar frames
		if _, err := f.database.CreateChannel(ctx, "rr-fill-"+itoaTest(int64(i)), "text", "", "", 0); err != nil {
			t.Fatalf("CreateChannel: %v", err)
		}
	}
	u := f.addUser("rr-room", rrMemberRole, 0)
	send := make(chan []byte, sendBufSize)
	c := NewTestClientWithUser(f.hub, f.clients[u].user, 0, send)
	f.hub.mu.Lock()
	f.hub.clients[u] = []*Client{c}
	f.hub.mu.Unlock()
	f.hub.pubsub.Subscribe(c, TopicGlobal)
	f.hub.pubsub.Subscribe(c, UserTopic(u))
	for range 192 {
		send <- []byte(`{"type":"filler"}`)
	}
	f.setRole(u, rrModRole)

	pumped := make(chan struct{})
	g := func(int64) {
		go func() {
			defer close(pumped)
			// Dispatch pushes while the worker waits for the queue.
			time.Sleep(10 * time.Millisecond)
			for range 64 {
				f.hub.BroadcastToAll(buildMemberUpdate(1, "x", nil))
			}
			// The writer catches up a little later.
			time.Sleep(60 * time.Millisecond)
			for len(send) > sendBufSize-2*roleRefreshChunk {
				<-send
			}
		}()
	}
	f.hub.roleRefresh.sendGate.Store(&g)
	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{u}})
	select {
	case <-pumped:
	case <-time.After(10 * time.Second):
		t.Fatal("the pump never finished")
	}
	rrWaitFor(t, "the round to settle", func() bool { return !f.hub.roleRefresh.covers(u) })
	if f.hub.ClientForTest(u) != c {
		t.Error("the client was closed while the worker and dispatch both pushed")
	}
	if n := f.hub.bpQueueDisconnects.Load(); n != 0 {
		t.Errorf("bpQueueDisconnects = %d, want 0", n)
	}
}
