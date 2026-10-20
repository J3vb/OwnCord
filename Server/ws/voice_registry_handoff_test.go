package ws

import (
	"context"
	"reflect"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"
)

// WP 5.3c: hand-offs move the whole slot; the grace window and shutdown are
// owned by the registry.

// recordingLeaveStore counts the voice_states row deletes that reach the store.
type recordingLeaveStore struct {
	VoiceStore
	leaves atomic.Int32
}

func (s *recordingLeaveStore) LeaveIfMatch(ctx context.Context, userID, chID int64, joinedAt string) (bool, error) {
	s.leaves.Add(1)
	return s.VoiceStore.LeaveIfMatch(ctx, userID, chID, joinedAt)
}

// slotField returns field i of the addressable struct v, readable and
// settable even when the field is unexported.
func slotField(v reflect.Value, i int) reflect.Value {
	f := v.Field(i)
	return reflect.NewAt(f.Type(), unsafe.Pointer(f.UnsafeAddr())).Elem()
}

// setNonZero gives v a non-zero value of its kind, recursing into structs,
// pointers and slices. A kind it does not know fails the test: a new field of
// a new kind has to teach this helper (and so be thought about) first.
func setNonZero(t *testing.T, name string, v reflect.Value) {
	t.Helper()
	switch v.Kind() {
	case reflect.Bool:
		v.SetBool(true)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		v.SetInt(7)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		v.SetUint(7)
	case reflect.String:
		v.SetString("x-" + name)
	case reflect.Pointer:
		v.Set(reflect.New(v.Type().Elem()))
		setNonZero(t, name, v.Elem())
	case reflect.Slice:
		v.Set(reflect.MakeSlice(v.Type(), 1, 1))
		setNonZero(t, name, v.Index(0))
	case reflect.Struct:
		for i := range v.NumField() {
			setNonZero(t, name+"."+v.Type().Field(i).Name, slotField(v, i))
		}
	default:
		t.Fatalf("voiceSlot field %s has kind %s, which setNonZero does not know: teach it, and make "+
			"voiceTxn.transfer carry or reset the field", name, v.Kind())
	}
}

// slotFields lists the voiceSlot fields a hand-off must treat: all but the lock.
func slotFields(t *testing.T) []int {
	t.Helper()
	typ := reflect.TypeFor[voiceSlot]()
	var out []int
	for i := range typ.NumField() {
		if typ.Field(i).Name != "voiceMu" {
			out = append(out, i)
		}
	}
	if len(out) == 0 {
		t.Fatal("voiceSlot has no fields besides its lock")
	}
	return out
}

// A hand-off must move every voiceSlot field or deliberately reset it (OC-0270,
// OC-0302). The test fills each field, hands the slot over and requires the
// field to have arrived intact and left the old slot empty, so a field added
// later that transfer does not know fails here instead of silently vanishing
// on the next reconnect.
func TestVoiceRegistry_TransferCarriesEveryField(t *testing.T) {
	h := newEmitTestHub()
	old := NewTestClient(h, 1, make(chan []byte, 8))
	next := NewTestClient(h, 1, make(chan []byte, 8))
	oldV := reflect.ValueOf(&old.voice).Elem()
	nextV := reflect.ValueOf(&next.voice).Elem()

	fields := slotFields(t)
	want := map[int]any{}
	for _, i := range fields {
		name := oldV.Type().Field(i).Name
		setNonZero(t, name, slotField(oldV, i))
		want[i] = slotField(oldV, i).Interface()
	}

	txn := h.begin(1)
	moved := txn.transfer(old, next, true)
	txn.end()

	if moved != 7 {
		t.Errorf("transfer reported channel %d, want the old slot's 7", moved)
	}
	for _, i := range fields {
		name := oldV.Type().Field(i).Name
		if got := slotField(nextV, i).Interface(); !reflect.DeepEqual(got, want[i]) {
			t.Errorf("voiceSlot.%s: new slot holds %#v after transfer, want %#v: transfer must carry it", name, got, want[i])
		}
		if !slotField(oldV, i).IsZero() {
			t.Errorf("voiceSlot.%s: old slot still holds %#v after transfer: transfer must reset it", name, slotField(oldV, i).Interface())
		}
	}
}

// Without a resume, or when the replaced join never completed, only the
// moderator's pending flags move; the old slot is emptied either way.
func TestVoiceRegistry_TransferMovesMembershipOnlyOnCompletedResume(t *testing.T) {
	cases := []struct {
		name      string
		resume    bool
		completed bool
		wantChID  int64
	}{
		{"fresh connect", false, true, 0},
		{"resume of an incomplete join", true, false, 0},
		{"resume of a completed join", true, true, 5},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newEmitTestHub()
			old := NewTestClient(h, 1, make(chan []byte, 8))
			next := NewTestClient(h, 1, make(chan []byte, 8))
			old.voice.setState(5, "tok")
			if tc.completed {
				old.voice.markCompletedIfMatch(5, "tok")
			}
			old.voice.stashModFlags(true, false, nil)

			txn := h.begin(1)
			txn.transfer(old, next, tc.resume)
			txn.end()

			if ch := next.voice.channel(); ch != tc.wantChID {
				t.Errorf("new slot channel = %d, want %d", ch, tc.wantChID)
			}
			if ch := old.voice.channel(); ch != 0 {
				t.Errorf("old slot channel = %d, want it emptied", ch)
			}
			if muted, _, _ := next.voice.takeModFlags(); !muted {
				t.Error("the moderator's pending mute did not move")
			}
		})
	}
}

// waitForWaiters polls until n callers hold or wait on userID's member lock.
func waitForWaiters(t *testing.T, h *Hub, userID int64, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for h.voiceReg.voiceMember.refsForTest(userID) < n {
		if time.Now().After(deadline) {
			t.Fatalf("lock for user %d never reached %d holders/waiters", userID, n)
		}
		time.Sleep(time.Millisecond)
	}
}

func waitForNoWaiters(t *testing.T, h *Hub, userID int64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for h.voiceReg.voiceMember.refsForTest(userID) > 0 {
		if time.Now().After(deadline) {
			t.Fatalf("lock for user %d still held", userID)
		}
		time.Sleep(time.Millisecond)
	}
}

// A moderator move stashes the target's mute/deafen in the same transaction as
// the eviction. A channel switch of the target's own that holds the lock first
// leaves nothing stashed and nothing evicted, and a move that gets there first
// hands the stash, whole, to the target's re-join.
func TestVoiceRegistry_ModMoveStashSurvivesRacingSwitch(t *testing.T) {
	t.Run("switch wins the lock", func(t *testing.T) {
		f := newTxnFixture(t, nil)
		f.join(t)
		ctx := context.Background()

		hold := f.h.begin(f.uid) // the target's switch is mid-flight
		done := make(chan bool, 1)
		go func() {
			done <- f.h.EvictForModeratorMove(ctx, f.uid, f.chID, true, false, nil)
		}()
		waitForWaiters(t, f.h, f.uid, 2)

		if muted, _ := PeekClientPendingModFlagsForTest(f.c); muted {
			t.Error("the stash became visible before the eviction could run")
		}
		// The switch completes: out of the old channel, into another.
		f.h.handleVoiceLeave(ctx, hold, f.c, voiceLeaveReasonSwitch)
		f.c.voice.setState(f.chID+1, "switched")
		hold.end()

		if <-done {
			t.Error("the move evicted a target that had already switched channel")
		}
		if muted, deafened := PeekClientPendingModFlagsForTest(f.c); muted || deafened {
			t.Error("a refused move left a stash for the target's next unrelated join")
		}
		if ch := f.c.voice.channel(); ch != f.chID+1 {
			t.Errorf("the switch target lost its new channel: now %d", ch)
		}
	})

	t.Run("move wins the lock", func(t *testing.T) {
		f := newTxnFixture(t, nil)
		f.join(t)
		ctx := context.Background()
		by := int64(42)

		if !f.h.EvictForModeratorMove(ctx, f.uid, f.chID, true, true, &by) {
			t.Fatal("the move did not evict a target still in the channel")
		}
		if ch := f.c.voice.channel(); ch != 0 {
			t.Errorf("target still in channel %d after the eviction", ch)
		}
		muted, deafened, mutedBy := f.c.voice.takeModFlags()
		if !muted || !deafened || mutedBy == nil || *mutedBy != by {
			t.Errorf("stash = (%v, %v, %v), want (true, true, %d)", muted, deafened, mutedBy, by)
		}
	})
}

// Shutdown: close stops every parked timer and drops the entries without a
// database write, and a readPump that parks afterwards arms nothing.
func TestVoiceRegistry_CloseStopsGraceTimers(t *testing.T) {
	withGraceWindow(t, 40*time.Millisecond)
	f := newTxnFixture(t, nil)
	rec := &recordingLeaveStore{VoiceStore: f.h.voice}
	f.h.voice = rec
	token := f.join(t)

	txn := f.h.begin(f.uid)
	if _, handled := txn.park(f.c); !handled {
		t.Fatal("a completed membership was not parked")
	}
	txn.end()
	if !f.h.voiceReg.voiceGrace.has(f.uid, f.chID) {
		t.Fatal("precondition: no grace entry after park")
	}

	f.h.GracefulStopContext(canceledContext(), RestartReasonShutdown)
	if f.h.voiceReg.voiceGrace.get(f.uid) != nil {
		t.Error("shutdown left a grace entry")
	}

	// A readPump parking after the sockets closed: the slot is cleared, no
	// timer is armed and nothing is written.
	f.c.voice.setState(f.chID, token)
	f.c.voice.markCompletedIfMatch(f.chID, token)
	txn = f.h.begin(f.uid)
	snap, handled := txn.park(f.c)
	txn.end()
	if !handled || snap.chID != f.chID {
		t.Errorf("late park = (%+v, %v), want the membership handled", snap, handled)
	}
	if ch := f.c.voice.channel(); ch != 0 {
		t.Errorf("late park left the slot in channel %d", ch)
	}
	if f.h.voiceReg.voiceGrace.get(f.uid) != nil {
		t.Error("late park armed a grace entry")
	}

	// An incomplete join and a kicked client are not parkable, but after close
	// they are dropped the same way: handled, with no teardown and no write.
	for _, kicked := range []bool{false, true} {
		f.c.voice.setState(f.chID, token)
		if kicked {
			f.c.voice.markCompletedIfMatch(f.chID, token)
			f.c.markTerminalKick()
		}
		txn = f.h.begin(f.uid)
		snap, handled = txn.park(f.c)
		txn.end()
		if !handled || snap.chID != f.chID {
			t.Errorf("late park (kicked=%v) = (%+v, %v), want handled", kicked, snap, handled)
		}
		if f.h.voiceReg.voiceGrace.get(f.uid) != nil {
			t.Errorf("late park (kicked=%v) armed a grace entry", kicked)
		}
	}

	time.Sleep(10 * voiceGraceWindow) // several windows: a surviving timer would have fired
	waitForNoWaiters(t, f.h, f.uid)
	if n := rec.leaves.Load(); n != 0 {
		t.Errorf("%d voice_states deletes after shutdown, want none", n)
	}
	row, err := f.h.voice.State(context.Background(), f.uid)
	if err != nil || row == nil {
		t.Errorf("shutdown touched the membership row: %+v, %v", row, err)
	}
}

// blockingLeaveStore holds LeaveIfMatch until release is closed.
type blockingLeaveStore struct {
	VoiceStore
	entered chan struct{}
	release chan struct{}
}

func (s *blockingLeaveStore) LeaveIfMatch(ctx context.Context, userID, chID int64, joinedAt string) (bool, error) {
	close(s.entered)
	<-s.release
	return s.VoiceStore.LeaveIfMatch(ctx, userID, chID, joinedAt)
}

// A grace expiry whose teardown already started when shutdown runs: close
// waits for it, so it cannot write after GracefulStopContext returns.
func TestVoiceRegistry_CloseWaitsForInFlightExpiry(t *testing.T) {
	withGraceWindow(t, 20*time.Millisecond)
	f := newTxnFixture(t, nil)
	store := &blockingLeaveStore{VoiceStore: f.h.voice, entered: make(chan struct{}), release: make(chan struct{})}
	f.h.voice = store
	f.join(t)

	txn := f.h.begin(f.uid)
	if _, handled := txn.park(f.c); !handled {
		t.Fatal("a completed membership was not parked")
	}
	txn.end()

	select {
	case <-store.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the grace expiry never reached the row delete")
	}
	closed := make(chan struct{})
	go func() {
		f.h.voiceReg.voiceGrace.close()
		close(closed)
	}()
	select {
	case <-closed:
		t.Fatal("close returned while an expiry teardown was still writing")
	case <-time.After(50 * time.Millisecond):
	}
	close(store.release)
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("close did not return after the expiry finished")
	}
}

func canceledContext() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

// A reconnect landing as the grace timer fires: under the member lock exactly
// one of inherit and the expiry teardown runs.
func TestVoiceRegistry_GraceFireRacesReconnect(t *testing.T) {
	setup := func(t *testing.T) (*txnFixture, *recordingLeaveStore) {
		withGraceWindow(t, 20*time.Millisecond)
		f := newTxnFixture(t, nil)
		rec := &recordingLeaveStore{VoiceStore: f.h.voice}
		f.h.voice = rec
		f.join(t)
		return f, rec
	}
	park := func(t *testing.T, f *txnFixture) {
		t.Helper()
		txn := f.h.begin(f.uid)
		defer txn.end()
		if _, handled := txn.park(f.c); !handled {
			t.Fatal("a completed membership was not parked")
		}
	}

	t.Run("reconnect holds the lock as the timer fires", func(t *testing.T) {
		f, rec := setup(t)
		park(t, f)

		resumed := NewTestClient(f.h, f.uid, make(chan []byte, 8))
		resumed.lastSeq = 1
		txn := f.h.begin(f.uid) // the resuming handshake
		waitForWaiters(t, f.h, f.uid, 1)
		time.Sleep(3 * voiceGraceWindow) // the timer fires and queues behind us
		waitForWaiters(t, f.h, f.uid, 2)
		if ch := txn.inherit(resumed); ch != f.chID {
			t.Fatalf("inherit = %d, want %d", ch, f.chID)
		}
		txn.end()
		waitForNoWaiters(t, f.h, f.uid)

		if n := rec.leaves.Load(); n != 0 {
			t.Errorf("the expiry tore down a membership the reconnect had inherited (%d deletes)", n)
		}
		if ch := resumed.voice.channel(); ch != f.chID {
			t.Errorf("resumed slot channel = %d, want %d", ch, f.chID)
		}
	})

	t.Run("timer holds the lock first", func(t *testing.T) {
		f, rec := setup(t)
		park(t, f)

		deadline := time.Now().Add(5 * time.Second)
		for rec.leaves.Load() == 0 {
			if time.Now().After(deadline) {
				t.Fatal("the grace timer never tore the membership down")
			}
			time.Sleep(time.Millisecond)
		}
		waitForNoWaiters(t, f.h, f.uid)

		resumed := NewTestClient(f.h, f.uid, make(chan []byte, 8))
		resumed.lastSeq = 1
		txn := f.h.begin(f.uid)
		ch := txn.inherit(resumed)
		txn.end()
		if ch != 0 {
			t.Errorf("inherit = %d after the expiry tore the membership down, want 0", ch)
		}
		if n := rec.leaves.Load(); n != 1 {
			t.Errorf("%d voice_states deletes, want exactly 1", n)
		}
	})
}
