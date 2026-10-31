package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

const (
	clAlice = int64(1)
	clBob   = int64(2)
	clCarol = int64(3)
	clDM    = int64(50)
)

var clT0 = time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)

// clClock is the injected clock the worker reads.
type clClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// clSink records what the worker hands to the sink.
type clSink struct {
	mu      sync.Mutex
	created []CallLogEvent
	ended   []CallLogEvent
}

func (s *clSink) CallLogCreated(_ context.Context, ev CallLogEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.created = append(s.created, ev)
}

func (s *clSink) CallLogEnded(_ context.Context, ev CallLogEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ended = append(s.ended, ev)
}

func (s *clSink) counts() (created, ended int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.created), len(s.ended)
}

type callLogFixture struct {
	database *db.DB
	svc      *CallLogService
	sink     *clSink
	clock    *clClock
}

// newCallLogFixture is a one-to-one DM (alice, bob, channel 50) where bob has
// accepted alice and alice has accepted bob, with the worker's notes enabled
// and its clock under the test's control. Tests drive reconcile directly.
func newCallLogFixture(t *testing.T) *callLogFixture {
	t.Helper()
	database, permSvc := newDMFixture(t)
	ctx := context.Background()
	for _, p := range [][2]int64{{clBob, clAlice}, {clAlice, clBob}} {
		if err := database.TrustSender(ctx, p[0], p[1], "accepted"); err != nil {
			t.Fatalf("TrustSender: %v", err)
		}
	}
	f := &callLogFixture{database: database, sink: &clSink{}, clock: &clClock{t: clT0}}
	f.svc = NewCallLogService(database, NewDMService(database, permSvc))
	f.svc.now = f.clock.now
	f.svc.SetSink(f.sink)
	f.svc.running = true
	return f
}

// join puts userID in the channel's voice room and notes it at the clock.
func (f *callLogFixture) join(t *testing.T, userID, channelID int64) {
	t.Helper()
	if err := f.database.JoinVoiceChannel(context.Background(), userID, channelID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	f.svc.NoteJoin(channelID, userID, f.clock.now())
}

// leave removes userID's voice row and notes it at the clock.
func (f *callLogFixture) leave(t *testing.T, userID, channelID int64) {
	t.Helper()
	if err := f.database.LeaveVoiceChannel(context.Background(), userID); err != nil {
		t.Fatalf("LeaveVoiceChannel: %v", err)
	}
	f.svc.NoteLeave(channelID, f.clock.now())
}

func (f *callLogFixture) pass(t *testing.T) {
	t.Helper()
	f.svc.reconcileAll(context.Background())
}

func (f *callLogFixture) open(t *testing.T, channelID int64) *db.OpenCall {
	t.Helper()
	oc, err := f.database.GetOpenCall(context.Background(), channelID)
	if err != nil {
		t.Fatalf("GetOpenCall: %v", err)
	}
	return oc
}

func (f *callLogFixture) callRows(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM message_calls`).Scan(&n); err != nil {
		t.Fatalf("count calls: %v", err)
	}
	return n
}

func (f *callLogFixture) info(t *testing.T, msgID int64) *db.CallInfo {
	t.Helper()
	ci, err := f.database.GetCallInfo(context.Background(), msgID)
	if err != nil || ci == nil {
		t.Fatalf("GetCallInfo(%d) = %v, %v", msgID, ci, err)
	}
	return ci
}

func TestCallLog_FirstJoinCreatesRowAuthoredByFirstJoiner(t *testing.T) {
	f := newCallLogFixture(t)
	f.join(t, clBob, clDM)
	f.clock.advance(3 * time.Second)
	f.join(t, clAlice, clDM)
	f.clock.advance(2 * time.Second)
	f.pass(t)

	oc := f.open(t, clDM)
	if oc == nil {
		t.Fatal("no live call after the first join")
	}
	if oc.AuthorID != clBob {
		t.Errorf("author = %d, want %d (the first joiner)", oc.AuthorID, clBob)
	}
	if oc.StartedAt != "2026-10-16 10:00:00" {
		t.Errorf("started_at = %q, want the first join time", oc.StartedAt)
	}
	msg, err := f.database.GetMessage(context.Background(), oc.MessageID)
	if err != nil || msg == nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if msg.Kind != db.MessageKindCall || msg.Content != "started a call." {
		t.Errorf("message = kind %d content %q", msg.Kind, msg.Content)
	}
	if got := f.info(t, oc.MessageID).Participants; !slices.Equal(got, []int64{clAlice, clBob}) {
		t.Errorf("participants = %v, want both joiners", got)
	}
	created, ended := f.sink.counts()
	if created != 1 || ended != 0 {
		t.Fatalf("sink created/ended = %d/%d, want 1/0", created, ended)
	}
	if aud := f.sink.created[0].Audience; len(aud) != 2 {
		t.Errorf("audience = %v, want both participants", aud)
	}
}

func TestCallLog_SimultaneousJoinsOneRow(t *testing.T) {
	f := newCallLogFixture(t)
	f.join(t, clAlice, clDM)
	f.join(t, clBob, clDM)
	f.pass(t)
	f.pass(t)
	if n := f.callRows(t); n != 1 {
		t.Fatalf("call rows = %d, want 1", n)
	}
	if created, _ := f.sink.counts(); created != 1 {
		t.Errorf("created frames = %d, want 1", created)
	}
	// The unique index backs the worker up: a second row for the channel
	// conflicts, and the worker then tends the existing one.
	_, err := f.database.CreateCallLog(context.Background(), db.CallLogParams{
		ChannelID: clDM, AuthorID: clBob, Content: "x", StartedAt: "2026-10-16 10:00:00", LastSeenAt: "2026-10-16 10:00:00",
	})
	if !errors.Is(err, db.ErrConflict) {
		t.Errorf("second open call = %v, want ErrConflict", err)
	}
}

func TestCallLog_NotesFromManyGoroutinesShareOneEntry(t *testing.T) {
	f := newCallLogFixture(t)
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func(uid int64) {
			defer wg.Done()
			f.svc.NoteJoin(clDM, uid, clT0)
			f.svc.NoteLeave(clDM, clT0.Add(time.Second))
		}(int64(i + 1))
	}
	wg.Wait()
	dirty := f.svc.takeDirty()
	p := dirty[clDM]
	if len(dirty) != 1 || p == nil || len(p.joiners) != 20 {
		t.Fatalf("dirty = %d channels, joiners = %v, want one entry with 20 joiners", len(dirty), p)
	}
	if !p.lastLeave.Equal(clT0.Add(time.Second)) {
		t.Errorf("lastLeave = %v", p.lastLeave)
	}
}

func TestCallLog_NotesDoNothingWhenWorkerNotRunning(t *testing.T) {
	f := newCallLogFixture(t)
	f.svc.running = false
	f.svc.NoteJoin(clDM, clAlice, clT0)
	f.svc.NoteLeave(clDM, clT0)
	if n := len(f.svc.takeDirty()); n != 0 {
		t.Errorf("dirty entries = %d, want 0", n)
	}
	var nilSvc *CallLogService
	nilSvc.NoteJoin(clDM, clAlice, clT0) // must not panic
	nilSvc.NoteLeave(clDM, clT0)
}

func TestCallLog_EndsAfterGraceAtLastLeave(t *testing.T) {
	f := newCallLogFixture(t)
	f.join(t, clAlice, clDM)
	f.join(t, clBob, clDM)
	f.pass(t)
	oc := f.open(t, clDM)

	f.clock.advance(60 * time.Second)
	f.leave(t, clBob, clDM)
	f.clock.advance(time.Second)
	f.leave(t, clAlice, clDM)
	leftAt := f.clock.now()

	f.clock.advance(2 * time.Second) // the coalesce window
	f.pass(t)
	if _, ended := f.sink.counts(); ended != 0 || f.open(t, clDM) == nil {
		t.Fatal("the call ended before the grace period")
	}
	f.clock.advance(9 * time.Second) // 11 s since the last leave
	f.svc.reconcileDue(context.Background())

	if f.open(t, clDM) != nil {
		t.Fatal("call still live after the grace period")
	}
	ci := f.info(t, oc.MessageID)
	if ci.EndedAt == nil || *ci.EndedAt != formatCallTime(leftAt) {
		t.Errorf("ended_at = %v, want the last leave %s", ci.EndedAt, formatCallTime(leftAt))
	}
	msg, _ := f.database.GetMessage(context.Background(), oc.MessageID)
	if msg.Content != "started a call that lasted 1 minute." {
		t.Errorf("content = %q", msg.Content)
	}
	if _, ended := f.sink.counts(); ended != 1 {
		t.Fatalf("ended frames = %d, want 1", ended)
	}
	ev := f.sink.ended[0]
	if ev.MessageID != oc.MessageID || ev.Call.EndedAt == nil || len(ev.Audience) != 2 {
		t.Errorf("ended event = %+v", ev)
	}
	// Ending again does nothing.
	f.svc.reconcileDue(context.Background())
	f.pass(t)
	if _, ended := f.sink.counts(); ended != 1 {
		t.Errorf("ended frames after a repeat = %d, want 1", ended)
	}
}

func TestCallLog_RejoinWithinGraceSameRowNoFrames(t *testing.T) {
	f := newCallLogFixture(t)
	f.join(t, clAlice, clDM)
	f.pass(t)
	oc := f.open(t, clDM)

	f.clock.advance(30 * time.Second)
	f.leave(t, clAlice, clDM)
	f.clock.advance(2 * time.Second)
	f.pass(t)
	f.clock.advance(5 * time.Second)
	f.join(t, clAlice, clDM)
	f.clock.advance(2 * time.Second)
	f.pass(t)
	f.clock.advance(30 * time.Second)
	f.pass(t)
	f.svc.reconcileDue(context.Background())

	again := f.open(t, clDM)
	if again == nil || again.MessageID != oc.MessageID {
		t.Fatalf("live call = %+v, want the same row %d", again, oc.MessageID)
	}
	created, ended := f.sink.counts()
	if created != 1 || ended != 0 {
		t.Errorf("frames created/ended = %d/%d, want 1/0", created, ended)
	}
	if n := f.callRows(t); n != 1 {
		t.Errorf("call rows = %d, want 1", n)
	}
}

func TestCallLog_ShortJoinerIsParticipant(t *testing.T) {
	f := newCallLogFixture(t)
	f.join(t, clAlice, clDM)
	f.join(t, clBob, clDM)
	f.clock.advance(time.Second)
	f.leave(t, clBob, clDM) // gone before the worker looks
	f.clock.advance(2 * time.Second)
	f.pass(t)
	oc := f.open(t, clDM)
	if oc == nil {
		t.Fatal("no live call")
	}
	if got := f.info(t, oc.MessageID).Participants; !slices.Equal(got, []int64{clAlice, clBob}) {
		t.Errorf("participants = %v, want the short joiner too", got)
	}
}

func TestCallLog_GuildVoiceIgnored(t *testing.T) {
	f := newCallLogFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 60, Name: "lounge", Type: "voice"})
	f.join(t, clAlice, 60)
	f.pass(t)
	if n := f.callRows(t); n != 0 {
		t.Errorf("call rows = %d, want none for a guild voice channel", n)
	}
	if created, _ := f.sink.counts(); created != 0 {
		t.Error("a frame was sent for a guild voice channel")
	}
	if n := len(f.svc.dirty); n != 0 {
		t.Errorf("dirty entries left = %d", n)
	}
}

func TestCallLog_OneToOneUntrustedWritesNothing(t *testing.T) {
	f := newCallLogFixture(t)
	if _, err := f.database.ExecContext(context.Background(), `DELETE FROM trusted_senders WHERE recipient_id = ? AND sender_id = ?`, clBob, clAlice); err != nil {
		t.Fatal(err)
	}
	f.join(t, clAlice, clDM)
	f.pass(t)
	if n := f.callRows(t); n != 0 {
		t.Fatalf("call rows = %d, want none while bob has not accepted alice", n)
	}
	if !f.svc.isSuppressed(clDM) {
		t.Error("channel not suppressed")
	}
	// Bob joining later does not change that while the room stays occupied.
	f.join(t, clBob, clDM)
	f.pass(t)
	if n := f.callRows(t); n != 0 {
		t.Errorf("call rows = %d after the second join, want none", n)
	}
	// Once the room is empty the suppression lifts.
	f.leave(t, clAlice, clDM)
	f.leave(t, clBob, clDM)
	f.pass(t)
	if f.svc.isSuppressed(clDM) {
		t.Error("still suppressed after the room emptied")
	}
}

// flakyTargetsStore fails the delivery-target read while fail is set.
type flakyTargetsStore struct {
	Store
	fail atomic.Bool
}

func (s *flakyTargetsStore) GetDMDeliveryTargets(ctx context.Context, ch, u int64) (bool, []db.DMDeliveryTarget, error) {
	if s.fail.Load() {
		return false, nil, errors.New("busy")
	}
	return s.Store.GetDMDeliveryTargets(ctx, ch, u)
}

// A failed trust read writes no row and keeps the notes; once the read works
// again the call is logged while the room is still occupied.
func TestCallLog_TrustLookupErrorWritesNothing(t *testing.T) {
	f := newCallLogFixture(t)
	st := &flakyTargetsStore{Store: f.database}
	st.fail.Store(true)
	f.svc.st = st
	f.join(t, clAlice, clDM)
	f.pass(t)
	if n := f.callRows(t); n != 0 {
		t.Errorf("call rows = %d, want none when the trust read fails", n)
	}
	if f.svc.isSuppressed(clDM) {
		t.Error("a lookup error must not suppress the channel")
	}
	f.clock.advance(f.svc.tick)
	f.pass(t)
	if n := f.callRows(t); n != 0 {
		t.Errorf("call rows = %d, want none while the error persists", n)
	}
	st.fail.Store(false)
	f.clock.advance(f.svc.tick)
	f.pass(t)
	if n := f.callRows(t); n != 1 {
		t.Errorf("call rows = %d, want 1 after the lookup recovers", n)
	}
}

func TestCallLog_GroupDMHasNoTrustGate(t *testing.T) {
	f := newCallLogFixture(t)
	ctx := context.Background()
	seedUser(t, f.database, &db.User{ID: clCarol, Username: "carol"})
	seedDMParticipant(t, f.database, clDM, clCarol)
	if _, err := f.database.ExecContext(ctx, `UPDATE channels SET is_group = 1 WHERE id = ?`, clDM); err != nil {
		t.Fatal(err)
	}
	if _, err := f.database.ExecContext(ctx, `DELETE FROM trusted_senders`); err != nil {
		t.Fatal(err)
	}
	f.join(t, clAlice, clDM)
	f.pass(t)
	if f.open(t, clDM) == nil {
		t.Fatal("a group DM call was not logged")
	}
	if aud := f.sink.created[0].Audience; len(aud) != 3 {
		t.Errorf("audience = %v, want every member", aud)
	}
}

func TestCallLog_RecoveryEndsOpenCallsAtLastSeen(t *testing.T) {
	// A call is live, then the server dies: no stop runs. Boot clears the
	// voice rows, and the next worker ends the call at the last time it was
	// seen occupied, then logs the end as a frame.
	f := newCallLogFixture(t)
	ctx := t.Context()
	row, err := f.database.CreateCallLog(ctx, db.CallLogParams{
		ChannelID: clDM, AuthorID: clAlice, Content: "started a call.",
		StartedAt: "2026-10-16 09:50:00", LastSeenAt: "2026-10-16 09:52:30", ParticipantIDs: []int64{clAlice, clBob},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.svc.running = false
	if err := f.database.ClearAllVoiceStates(ctx); err != nil {
		t.Fatal(err)
	}
	stop := f.svc.StartCallLogWorker(ctx)
	defer stop(ctx)

	ci := f.info(t, row.Message.ID)
	if ci.EndedAt == nil || *ci.EndedAt != "2026-10-16 09:52:30" {
		t.Fatalf("ended_at = %v, want the last-seen time", ci.EndedAt)
	}
	msg, _ := f.database.GetMessage(ctx, row.Message.ID)
	if msg.Content != "started a call that lasted 2 minutes." {
		t.Errorf("content = %q", msg.Content)
	}
	if _, ended := f.sink.counts(); ended != 1 {
		t.Fatalf("ended frames = %d, want 1", ended)
	}
	// A rejoin after the restart starts a new row.
	f.join(t, clAlice, clDM)
	f.svc.reconcileAll(ctx)
	if oc := f.open(t, clDM); oc == nil || oc.MessageID == row.Message.ID {
		t.Errorf("live call after the restart = %+v, want a new row", oc)
	}
}

func TestCallLog_StopStampsLastSeen(t *testing.T) {
	f := newCallLogFixture(t)
	f.svc.running = false
	ctx := t.Context()
	stop := f.svc.StartCallLogWorker(ctx)
	f.join(t, clAlice, clDM)
	f.pass(t)
	oc := f.open(t, clDM)
	f.clock.advance(5 * time.Minute)
	stop(ctx)
	got := f.open(t, clDM)
	if got == nil || got.MessageID != oc.MessageID {
		t.Fatalf("live call after stop = %+v", got)
	}
	if got.LastSeenAt != formatCallTime(clT0.Add(5*time.Minute)) {
		t.Errorf("last_seen_at = %q, want the stop time", got.LastSeenAt)
	}
	if _, ended := f.sink.counts(); ended != 0 {
		t.Error("stop must not broadcast an end")
	}
	stop(ctx) // a second stop is harmless
}

func TestCallLog_TickAdvancesLastSeen(t *testing.T) {
	f := newCallLogFixture(t)
	f.join(t, clAlice, clDM)
	f.pass(t)
	if got := f.open(t, clDM).LastSeenAt; got != formatCallTime(clT0) {
		t.Fatalf("last_seen_at at start = %q", got)
	}
	f.clock.advance(10 * time.Second)
	f.pass(t)
	if got := f.open(t, clDM).LastSeenAt; got != formatCallTime(clT0) {
		t.Errorf("last_seen_at moved after 10 s: %q", got)
	}
	f.clock.advance(callLogTick)
	f.pass(t)
	if got := f.open(t, clDM).LastSeenAt; got != formatCallTime(clT0.Add(callLogTick+10*time.Second)) {
		t.Errorf("last_seen_at after a tick = %q", got)
	}
}

func TestCallLog_ChannelDeletedDropsState(t *testing.T) {
	f := newCallLogFixture(t)
	f.svc.NoteJoin(999, clAlice, clT0)
	f.svc.setSuppressed(999, true)
	f.svc.setEmptySince(999, clT0)
	f.pass(t)
	f.svc.callLogMu.Lock()
	defer f.svc.callLogMu.Unlock()
	if len(f.svc.dirty)+len(f.svc.emptySince)+len(f.svc.suppressed) != 0 {
		t.Errorf("state kept for a missing channel: %v %v %v", f.svc.dirty, f.svc.emptySince, f.svc.suppressed)
	}
}

func TestCallLog_ReopensClosedDMBeforeRow(t *testing.T) {
	f := newCallLogFixture(t)
	ctx := context.Background()
	if err := f.database.CloseDM(ctx, clBob, clDM); err != nil {
		t.Fatal(err)
	}
	f.join(t, clAlice, clDM)
	f.pass(t)
	if created, _ := f.sink.counts(); created != 1 {
		t.Fatal("no created event")
	}
	ev := f.sink.created[0]
	if len(ev.Reopens) != 1 || ev.Reopens[0].UserID != clBob {
		t.Errorf("reopens = %+v, want one for bob", ev.Reopens)
	}
	if ok, err := f.database.OpenDMIfParticipant(ctx, clBob, clDM); err != nil || ok {
		t.Errorf("the DM was not reopened for bob (reopen=%v, %v)", ok, err)
	}
}

func TestCallLog_WorkerExitsOnCtxDone(t *testing.T) {
	f := newCallLogFixture(t)
	f.svc.running = false
	ctx, cancel := context.WithCancel(context.Background())
	stop := f.svc.StartCallLogWorker(ctx)
	cancel()
	select {
	case <-f.svc.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the worker loop did not exit when its context was cancelled")
	}
	stop(context.Background())
}

func TestCallLog_RequeuesNotesOnStoreError(t *testing.T) {
	f := newCallLogFixture(t)
	good := f.svc.st
	f.svc.st = errChannelStore{Store: good.(Store)}
	f.join(t, clAlice, clDM)
	f.pass(t)
	f.svc.st = good
	f.pass(t) // still backing off: nothing is attempted yet
	if f.open(t, clDM) != nil {
		t.Fatal("a channel inside its retry delay was reconciled")
	}
	f.clock.advance(f.svc.coalesce)
	f.pass(t)
	if f.open(t, clDM) == nil {
		t.Fatal("the join noted before a store error was lost")
	}
}

type errChannelStore struct{ Store }

func (errChannelStore) GetChannel(context.Context, int64) (*db.Channel, error) {
	return nil, errors.New("boom")
}

func TestVoiceService_NotesJoinAndLeaveOnlyWhenDeleted(t *testing.T) {
	f := newCallLogFixture(t)
	ctx := context.Background()
	voice := NewVoiceService(f.database)
	voice.SetCallLog(f.svc)
	voice.NoteJoinCompleted(clDM, clAlice)
	if p := f.svc.takeDirty()[clDM]; p == nil || len(p.joiners) != 1 {
		t.Fatalf("join note = %+v", p)
	}
	if err := voice.Join(ctx, clAlice, clDM, 0); err != nil {
		t.Fatal(err)
	}
	// A stale join token deletes nothing, so it notes nothing.
	if deleted, err := voice.LeaveIfMatch(ctx, clAlice, clDM, "stale"); err != nil || deleted {
		t.Fatalf("stale leave = %v, %v", deleted, err)
	}
	if n := len(f.svc.takeDirty()); n != 0 {
		t.Errorf("a leave that deleted nothing noted %d channels", n)
	}
	st, _ := voice.State(ctx, clAlice)
	if deleted, err := voice.LeaveIfMatch(ctx, clAlice, clDM, st.JoinedAt); err != nil || !deleted {
		t.Fatalf("leave = %v, %v", deleted, err)
	}
	if p := f.svc.takeDirty()[clDM]; p == nil || p.lastLeave.IsZero() {
		t.Errorf("leave note = %+v", p)
	}
	// A voice service with no call log is fine.
	NewVoiceService(f.database).NoteJoinCompleted(clDM, clAlice)
}

// Joins and leaves racing on one channel while the real worker runs: every
// call row ends up closed, and the channel never holds two live calls.
func TestCallLog_ConcurrentJoinsAndLeavesOneChannel(t *testing.T) {
	database, permSvc := newDMFixture(t)
	ctx := t.Context()
	const users = 6
	for id := int64(3); id <= users; id++ {
		seedUser(t, database, &db.User{ID: id, Username: fmt.Sprintf("u%d", id)})
		seedDMParticipant(t, database, clDM, id)
	}
	if _, err := database.ExecContext(ctx, `UPDATE channels SET is_group = 1 WHERE id = ?`, clDM); err != nil {
		t.Fatal(err)
	}
	svc := NewCallLogService(database, NewDMService(database, permSvc))
	svc.coalesce, svc.tick, svc.grace = 5*time.Millisecond, 50*time.Millisecond, 40*time.Millisecond
	voice := NewVoiceService(database)
	voice.SetCallLog(svc)
	stop := svc.StartCallLogWorker(ctx)
	defer stop(ctx)

	var wg sync.WaitGroup
	for uid := int64(1); uid <= users; uid++ {
		wg.Add(1)
		go func(uid int64) {
			defer wg.Done()
			for range 15 {
				if err := voice.Join(ctx, uid, clDM, 0); err != nil {
					t.Errorf("join: %v", err)
					return
				}
				voice.NoteJoinCompleted(clDM, uid)
				time.Sleep(time.Millisecond)
				if st, err := voice.State(ctx, uid); err == nil && st != nil {
					_, _ = voice.LeaveIfMatch(ctx, uid, clDM, st.JoinedAt)
				}
			}
		}(uid)
	}
	wg.Wait()

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if oc, err := database.GetOpenCall(ctx, clDM); err == nil && oc == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if oc, _ := database.GetOpenCall(ctx, clDM); oc != nil {
		t.Fatalf("call %d still live after everyone left", oc.MessageID)
	}
	var rows, open int
	_ = database.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(ended_at IS NULL), 0) FROM message_calls`).Scan(&rows, &open)
	if rows == 0 || open != 0 {
		t.Errorf("call rows = %d, still open = %d", rows, open)
	}
}

// Cycling in and out faster than the end grace stays one row and sends no
// frames beyond the first.
func TestCallLog_JoinLeaveCyclingInsideGraceStaysOneRow(t *testing.T) {
	f := newCallLogFixture(t)
	f.join(t, clAlice, clDM)
	f.pass(t)
	for range 20 {
		f.clock.advance(3 * time.Second)
		f.leave(t, clAlice, clDM)
		f.clock.advance(3 * time.Second)
		f.pass(t)
		f.join(t, clAlice, clDM)
		f.clock.advance(time.Second)
		f.pass(t)
	}
	if n := f.callRows(t); n != 1 {
		t.Errorf("call rows = %d after 20 cycles inside the grace period, want 1", n)
	}
	if created, ended := f.sink.counts(); created != 1 || ended != 0 {
		t.Errorf("frames created/ended = %d/%d, want 1/0", created, ended)
	}
}

// An unanswered call leaves one row for the callee to see as a missed call:
// the caller authors it and is its only participant, and the end reaches both.
func TestCallLog_UnansweredCallLeavesOneMissedRow(t *testing.T) {
	f := newCallLogFixture(t)
	f.join(t, clAlice, clDM) // the caller; bob never joins
	f.pass(t)
	f.clock.advance(20 * time.Second)
	f.leave(t, clAlice, clDM)
	f.clock.advance(2 * time.Second)
	f.pass(t)
	f.clock.advance(11 * time.Second)
	f.svc.reconcileDue(context.Background())

	if n := f.callRows(t); n != 1 {
		t.Fatalf("call rows = %d, want 1", n)
	}
	if f.open(t, clDM) != nil {
		t.Fatal("the call is still live after the grace period")
	}
	created, ended := f.sink.counts()
	if created != 1 || ended != 1 {
		t.Fatalf("frames created/ended = %d/%d, want 1/1", created, ended)
	}
	start, end := f.sink.created[0], f.sink.ended[0]
	if start.Author == nil || start.Author.ID != clAlice {
		t.Errorf("author = %+v, want the caller", start.Author)
	}
	if !slices.Equal(end.Call.Participants, []int64{clAlice}) || end.Call.EndedAt == nil {
		t.Errorf("ended call = %+v, want only the caller as a participant", end.Call)
	}
	for _, aud := range [][]int64{start.Audience, end.Audience} {
		if !slices.Equal(aud, []int64{clAlice, clBob}) {
			t.Errorf("audience = %v, want both DM members", aud)
		}
	}
}

// There is no server-side decline state: call_decline is a stateless nudge to
// the caller's client, so a declined call is the callee never joining.
func TestCallLog_CalleeDeclinesIsCalleeNeverJoining(t *testing.T) {
	f := newCallLogFixture(t)
	f.join(t, clAlice, clDM)
	f.pass(t)
	f.clock.advance(15 * time.Second)
	f.leave(t, clAlice, clDM)
	f.clock.advance(2 * time.Second)
	f.pass(t)
	f.clock.advance(11 * time.Second)
	f.svc.reconcileDue(context.Background())

	if n := f.callRows(t); n != 1 {
		t.Fatalf("call rows = %d, want 1", n)
	}
	if _, ended := f.sink.counts(); ended != 1 {
		t.Fatal("the call did not end")
	}
	if got := f.sink.ended[0].Call.Participants; !slices.Equal(got, []int64{clAlice}) {
		t.Errorf("participants = %v, want the caller only", got)
	}
}
