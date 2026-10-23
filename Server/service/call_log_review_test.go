package service

import (
	"context"
	"errors"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// The one-to-one acceptance gate needs both people to have accepted: a
// pending request, where the recipient starts the call, writes nothing.
func TestCallLog_PendingRequestRecipientStartsCallWritesNothing(t *testing.T) {
	f := newCallLogFixture(t)
	// alice asked bob: alice trusts bob, bob has not accepted alice.
	if _, err := f.database.ExecContext(context.Background(),
		`DELETE FROM trusted_senders WHERE recipient_id = ? AND sender_id = ?`, clBob, clAlice); err != nil {
		t.Fatal(err)
	}
	f.join(t, clBob, clDM) // bob starts the call
	f.pass(t)
	if n := f.callRows(t); n != 0 {
		t.Fatalf("call rows = %d, want none", n)
	}
	// Nothing is sent to the other person, and the call never produces a row
	// for them to see later.
	f.clock.advance(20 * time.Second)
	f.leave(t, clBob, clDM)
	f.clock.advance(2 * time.Second)
	f.pass(t)
	f.clock.advance(11 * time.Second)
	f.svc.reconcileDue(context.Background())
	if created, ended := f.sink.counts(); created != 0 || ended != 0 {
		t.Errorf("frames created/ended = %d/%d, want none", created, ended)
	}
	if n := f.callRows(t); n != 0 {
		t.Errorf("call rows = %d after the call, want none", n)
	}
}

// Who joined comes only from completion notes; a voice row is occupancy.
func TestCallLog_VoiceRowWithoutNoteIsNotAParticipantOrAuthor(t *testing.T) {
	f := newCallLogFixture(t)
	ctx := context.Background()
	if err := f.database.JoinVoiceChannel(ctx, clBob, clDM); err != nil { // no note
		t.Fatal(err)
	}
	f.pass(t)
	if n := f.callRows(t); n != 0 {
		t.Fatalf("a voice row alone started a call (%d rows)", n)
	}
	f.clock.advance(time.Second)
	f.join(t, clAlice, clDM)
	f.pass(t)
	oc := f.open(t, clDM)
	if oc == nil || oc.AuthorID != clAlice {
		t.Fatalf("open call = %+v, want one authored by alice", oc)
	}
	if got := f.info(t, oc.MessageID).Participants; !slices.Equal(got, []int64{clAlice}) {
		t.Errorf("participants = %v, want only the noted joiner", got)
	}
	// The unnoted row still keeps the room occupied.
	f.leave(t, clAlice, clDM) // removes alice's row only
	f.clock.advance(30 * time.Second)
	f.pass(t)
	f.svc.reconcileDue(ctx)
	if f.open(t, clDM) == nil {
		t.Error("the call ended while a voice row was still in the room")
	}
}

// A noted user who has since been removed neither blocks the channel nor
// becomes the author.
func TestCallLog_NoteForRemovedUserDoesNotBlockTheCall(t *testing.T) {
	f := newCallLogFixture(t)
	ctx := context.Background()
	f.svc.NoteJoin(clDM, 999, clT0.Add(-time.Second)) // earlier than alice, but gone
	f.join(t, clAlice, clDM)
	f.pass(t)
	oc := f.open(t, clDM)
	if oc == nil || oc.AuthorID != clAlice {
		t.Fatalf("open call = %+v, want alice as the author", oc)
	}

	seedUser(t, f.database, &db.User{ID: clCarol, Username: "carol"})
	f.svc.NoteJoin(clDM, clCarol, f.clock.now())
	if _, err := f.database.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, clCarol); err != nil {
		t.Fatal(err)
	}
	f.clock.advance(2 * time.Second)
	f.pass(t)
	f.leave(t, clAlice, clDM)
	f.clock.advance(2 * time.Second)
	f.pass(t)
	f.clock.advance(11 * time.Second)
	f.svc.reconcileDue(ctx)
	if f.open(t, clDM) != nil {
		t.Fatal("the call never ended")
	}
	if got := f.info(t, oc.MessageID).Participants; !slices.Equal(got, []int64{clAlice}) {
		t.Errorf("participants = %v", got)
	}
}

type authorFailStore struct {
	Store
	fail atomic.Bool
}

func (s *authorFailStore) CreateCallLog(ctx context.Context, p db.CallLogParams) (*db.CallLogRow, error) {
	row, err := s.Store.CreateCallLog(ctx, p)
	s.fail.Store(true)
	return row, err
}

func (s *authorFailStore) GetUserByID(ctx context.Context, id int64) (*db.User, error) {
	if s.fail.Load() {
		return nil, errors.New("boom")
	}
	return s.Store.GetUserByID(ctx, id)
}

// The row still goes out when the author cannot be read, so the frame that
// ends it has a row to update.
func TestCallLog_AuthorLookupFailureStillSendsTheRow(t *testing.T) {
	f := newCallLogFixture(t)
	f.svc.st = &authorFailStore{Store: f.database}
	f.join(t, clAlice, clDM)
	f.pass(t)
	if created, _ := f.sink.counts(); created != 1 {
		t.Fatalf("created frames = %d, want 1", created)
	}
	if a := f.sink.created[0].Author; a == nil || a.ID != clAlice {
		t.Errorf("author = %+v, want the id alone", a)
	}
}

// The end goes to everyone the start went to, even if standing changed.
func TestCallLog_EndReachesTheStartAudience(t *testing.T) {
	f := newCallLogFixture(t)
	f.join(t, clAlice, clDM)
	f.pass(t)
	if _, err := f.database.ExecContext(context.Background(),
		`DELETE FROM trusted_senders WHERE recipient_id = ? AND sender_id = ?`, clBob, clAlice); err != nil {
		t.Fatal(err)
	}
	f.clock.advance(5 * time.Second)
	f.leave(t, clAlice, clDM)
	f.clock.advance(2 * time.Second)
	f.pass(t)
	f.clock.advance(11 * time.Second)
	f.svc.reconcileDue(context.Background())
	if _, ended := f.sink.counts(); ended != 1 {
		t.Fatalf("ended frames = %d", ended)
	}
	if aud := f.sink.ended[0].Audience; !slices.Equal(aud, []int64{clAlice, clBob}) {
		t.Errorf("end audience = %v, want both", aud)
	}
}

// A member removed from a group mid-call gets no end frame; the others do.
func TestCallLog_GroupEndSkipsARemovedMember(t *testing.T) {
	f := newCallLogFixture(t)
	ctx := context.Background()
	seedUser(t, f.database, &db.User{ID: clCarol, Username: "carol"})
	seedDMParticipant(t, f.database, clDM, clCarol)
	if _, err := f.database.ExecContext(ctx, `UPDATE channels SET is_group = 1 WHERE id = ?`, clDM); err != nil {
		t.Fatal(err)
	}
	f.join(t, clAlice, clDM)
	f.pass(t)
	if aud := f.sink.created[0].Audience; !slices.Equal(aud, []int64{clAlice, clBob, clCarol}) {
		t.Fatalf("start audience = %v, want every member", aud)
	}
	if _, err := f.database.ExecContext(ctx,
		`DELETE FROM dm_participants WHERE channel_id = ? AND user_id = ?`, clDM, clCarol); err != nil {
		t.Fatal(err)
	}
	f.endAfterLeave(t, clAlice)
	if _, ended := f.sink.counts(); ended != 1 {
		t.Fatalf("ended frames = %d", ended)
	}
	if aud := f.sink.ended[0].Audience; !slices.Equal(aud, []int64{clAlice, clBob}) {
		t.Errorf("end audience = %v, want the current members only", aud)
	}
}

// A failed participant read at the end announces nothing but still ends the row.
func TestCallLog_EndTargetsErrorAnnouncesNothing(t *testing.T) {
	f := newCallLogFixture(t)
	st := &flakyTargetsStore{Store: f.database}
	f.svc.st = st
	f.join(t, clAlice, clDM)
	f.pass(t)
	oc := f.open(t, clDM)
	if oc == nil {
		t.Fatal("call was not logged")
	}
	st.fail.Store(true)
	f.endAfterLeave(t, clAlice)
	if _, ended := f.sink.counts(); ended != 0 {
		t.Errorf("ended frames = %d, want none when the participant read fails", ended)
	}
	if f.open(t, clDM) != nil {
		t.Error("the call is still open")
	}
	if f.info(t, oc.MessageID).EndedAt == nil {
		t.Error("the ended row was not stored")
	}
}

// endAfterLeave takes userID out of the room and runs the worker past the end grace.
func (f *callLogFixture) endAfterLeave(t *testing.T, userID int64) {
	t.Helper()
	f.clock.advance(5 * time.Second)
	f.leave(t, userID, clDM)
	f.clock.advance(2 * time.Second)
	f.pass(t)
	f.clock.advance(11 * time.Second)
	f.svc.reconcileDue(context.Background())
}

// A note left in the dirty map cannot open a second row after the end.
func TestCallLog_DueEndTakesTheChannelsPendingNotes(t *testing.T) {
	f := newCallLogFixture(t)
	f.join(t, clAlice, clDM)
	f.pass(t)
	f.clock.advance(5 * time.Second)
	f.leave(t, clAlice, clDM)
	f.clock.advance(2 * time.Second)
	f.pass(t)
	f.clock.advance(11 * time.Second)
	f.svc.NoteJoin(clDM, clAlice, f.clock.now().Add(-12*time.Second)) // stale, no voice row
	f.svc.reconcileDue(context.Background())
	f.pass(t)
	if n := f.callRows(t); n != 1 {
		t.Errorf("call rows = %d, want 1", n)
	}
	if f.open(t, clDM) != nil {
		t.Error("a second call was opened after the end")
	}
}

// Stop stamps a call that is empty and waiting out its grace period with the
// moment the room emptied.
func TestCallLog_StopStampsCallInGrace(t *testing.T) {
	f := newCallLogFixture(t)
	f.join(t, clAlice, clDM)
	f.pass(t)
	f.clock.advance(40 * time.Second)
	f.leave(t, clAlice, clDM)
	left := f.clock.now()
	f.clock.advance(2 * time.Second)
	f.pass(t) // empty, inside the grace period
	f.svc.stampLastSeen(t.Context())
	oc := f.open(t, clDM)
	if oc == nil || oc.LastSeenAt != formatCallTime(left) {
		t.Fatalf("open call = %+v, want last_seen_at at the moment the room emptied (%s)", oc, formatCallTime(left))
	}
}

// Start after a stop runs a fresh worker; concurrent starts run one.
func TestCallLog_StartAfterStopAndConcurrentStarts(t *testing.T) {
	f := newCallLogFixture(t)
	f.svc.running = false
	ctx := t.Context()
	stop := f.svc.StartCallLogWorker(ctx)
	first := f.svc.done
	stop(ctx)
	select {
	case <-first:
	default:
		t.Fatal("the first loop did not exit")
	}
	stop2 := f.svc.StartCallLogWorker(ctx)
	if f.svc.done == first {
		t.Fatal("a Start after a stop did not run a new loop")
	}
	// A Start while running is a no-op that leaves the loop alone.
	cur := f.svc.done
	done := make(chan struct{})
	for range 4 {
		go func() {
			f.svc.StartCallLogWorker(ctx)(ctx)
			done <- struct{}{}
		}()
	}
	for range 4 {
		<-done
	}
	if f.svc.done != cur {
		t.Error("a concurrent Start replaced the running loop")
	}
	stop2(ctx)
}

type countingStore struct {
	Store
	adds, ends atomic.Int64
	failEnd    bool
}

func (s *countingStore) AddCallParticipants(ctx context.Context, id int64, ids []int64) error {
	s.adds.Add(1)
	return s.Store.AddCallParticipants(ctx, id, ids)
}

func (s *countingStore) EndCall(ctx context.Context, id int64, at, content string) (bool, error) {
	s.ends.Add(1)
	if s.failEnd {
		return false, errors.New("busy")
	}
	return s.Store.EndCall(ctx, id, at, content)
}

// An unchanged room costs no participant write.
func TestCallLog_UnchangedRoomWritesNoParticipants(t *testing.T) {
	f := newCallLogFixture(t)
	cs := &countingStore{Store: f.database}
	f.svc.st = cs
	f.join(t, clAlice, clDM)
	f.join(t, clBob, clDM)
	f.pass(t)
	f.svc.NoteJoin(clDM, clAlice, f.clock.now())
	f.svc.NoteJoin(clDM, clBob, f.clock.now())
	f.clock.advance(2 * time.Second)
	f.pass(t)
	if n := cs.adds.Load(); n != 0 {
		t.Errorf("AddCallParticipants calls = %d, want 0", n)
	}
}

// A store that keeps failing is retried on a bounded schedule, not in a loop.
func TestCallLog_FailingEndIsRetriedOnABackoff(t *testing.T) {
	f := newCallLogFixture(t)
	cs := &countingStore{Store: f.database, failEnd: true}
	f.svc.st = cs
	f.svc.now = func() time.Time { return time.Now().UTC() }
	f.svc.coalesce, f.svc.tick, f.svc.grace = 10*time.Millisecond, 200*time.Millisecond, 20*time.Millisecond
	f.svc.running = false
	ctx := t.Context()
	stop := f.svc.StartCallLogWorker(ctx)
	defer stop(ctx)

	f.join(t, clAlice, clDM)
	deadline := time.Now().Add(5 * time.Second)
	for f.open(t, clDM) == nil && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if f.open(t, clDM) == nil {
		t.Fatal("no call started")
	}
	start := cs.ends.Load()
	f.leave(t, clAlice, clDM)
	time.Sleep(600 * time.Millisecond)
	attempts := cs.ends.Load() - start
	t.Logf("EndCall attempts: %d", attempts)
	if attempts < 2 || attempts > 12 {
		t.Errorf("EndCall attempts in 600 ms = %d, want a few (backoff), not a loop", attempts)
	}
	if f.open(t, clDM) == nil {
		t.Error("the call ended although EndCall always failed")
	}
}

// A leave note that has not been reconciled yet still dates the stop stamp.
func TestCallLog_StopStampsPendingLeave(t *testing.T) {
	f := newCallLogFixture(t)
	f.join(t, clAlice, clDM)
	f.pass(t)
	f.clock.advance(30 * time.Second)
	f.leave(t, clAlice, clDM)
	left := f.clock.now()
	f.clock.advance(5 * time.Second) // no pass: the leave stays pending
	f.svc.stampLastSeen(t.Context())
	oc := f.open(t, clDM)
	if oc == nil || oc.LastSeenAt != formatCallTime(left) {
		t.Fatalf("open call = %+v, want last_seen_at at the pending leave (%s)", oc, formatCallTime(left))
	}
}

// A Start while the previous loop is still finishing waits for it, so
// recovery never ends a call that loop still tends.
func TestCallLog_StartWaitsForPreviousLoop(t *testing.T) {
	f := newCallLogFixture(t)
	ctx := t.Context()
	if _, err := f.database.CreateCallLog(ctx, db.CallLogParams{
		ChannelID: clDM, AuthorID: clAlice, Content: "started a call.",
		StartedAt: "2026-10-16 09:50:00", LastSeenAt: "2026-10-16 09:52:30", ParticipantIDs: []int64{clAlice},
	}); err != nil {
		t.Fatal(err)
	}
	old := make(chan struct{})
	f.svc.callLogMu.Lock()
	f.svc.running = false
	f.svc.done = old
	f.svc.callLogMu.Unlock()
	started := make(chan func(context.Context))
	go func() { started <- f.svc.StartCallLogWorker(ctx) }()
	select {
	case <-started:
		t.Fatal("Start returned while the previous loop was alive")
	case <-time.After(100 * time.Millisecond):
	}
	if f.open(t, clDM) == nil {
		t.Fatal("recovery ran while the previous loop was alive")
	}
	close(old)
	stop := <-started
	defer stop(ctx)
	if f.open(t, clDM) != nil {
		t.Error("recovery did not run after the previous loop exited")
	}
}
