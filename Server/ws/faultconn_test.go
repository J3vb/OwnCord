package ws

// faultconn_test.go — B3-6 item 3: a seeded, deterministic fault-injecting
// frame transport (Tier 3c of docs/plans/bug-detection-improvements.md).
//
// FaultConn sits at the layer the headless-client harness actually uses: it
// wraps a client's outbound queue (the chan a real socket's writePump would
// drain), optionally preceded by a preface of handshake frames such as a
// resume's replay burst, and re-emits the frames with drops, duplicates,
// bounded reordering and an order-preserving lag drawn from its own PCG
// stream. Same seed, same schedule, same input order: same output.
//
// The one fault a TCP-backed WebSocket can really produce is a cut — every
// frame after some point is lost and the client must resume from its
// watermark. That is DropTail. Silent per-frame drops, duplicates and
// reorders are impossible on the real wire; they exist so a harness can
// prove its oracle notices them (hub_sim_test.go's RED control) and for the
// client model test, whose store must tolerate whatever a reconnect replays.
//
// ws_test reaches it through export_test.go (NewFaultConnForTest); the types
// below are exported so the schedule can be written from there too.

import (
	"cmp"
	"math/rand/v2"
	"slices"
	"testing"
)

// FaultSchedule is the per-frame fault mix a FaultConn applies.
type FaultSchedule struct {
	Drop          float64 // per-frame probability the frame is lost
	DropTail      bool    // a drop is a socket death: frames still in flight are lost and Recv reports FaultCut
	Dup           float64 // per-frame probability the frame is delivered twice, back to back
	Reorder       float64 // per-frame probability the frame is pushed back up to ReorderWindow places
	ReorderWindow int     // bound for Reorder; 0 means 1
	Delay         int     // lag in frames: a frame is released only once Delay later frames were pulled, or the source closed
}

// FaultStatus is what Recv reports alongside a frame.
type FaultStatus int

const (
	FaultOK     FaultStatus = iota // a frame
	FaultEmpty                     // nothing releasable yet; the source is still open
	FaultClosed                    // the source closed and everything it wrote has been released
	FaultCut                       // the schedule cut the connection; whatever was still in flight is gone
)

type faultFrame struct {
	key, idx int
	data     []byte
}

// FaultConn is the transport. Not safe for concurrent use; one reader owns it.
type FaultConn struct {
	rng     *rand.Rand
	sched   FaultSchedule
	preface [][]byte
	in      <-chan []byte
	pending []faultFrame // pulled, faults applied, awaiting release; sorted by key
	pulled  int
	closed  bool
	cut     bool

	Dropped, Duplicated, Reordered int
}

// seed and stream are the PCG's two words — one seed per run, one stream per
// connection — so no arithmetic mix can make two connections collide.
func newFaultConn(seed, stream uint64, sched FaultSchedule, preface [][]byte, in <-chan []byte) *FaultConn {
	return &FaultConn{
		rng:     rand.New(rand.NewPCG(seed, stream)),
		sched:   sched,
		preface: preface,
		in:      in,
	}
}

// pull moves every frame the source has ready into pending, drawing the
// schedule per frame in pull order — so batching never changes the outcome.
func (f *FaultConn) pull() {
	for !f.cut && !f.closed {
		var data []byte
		switch {
		case len(f.preface) > 0:
			data, f.preface = f.preface[0], f.preface[1:]
		case f.in == nil:
			f.closed = true
			return
		default:
			select {
			case d, ok := <-f.in:
				if !ok {
					f.closed = true
					return
				}
				data = d
			default:
				return
			}
		}
		idx := f.pulled
		f.pulled++
		if f.rng.Float64() < f.sched.Drop {
			f.Dropped++
			f.cut = f.sched.DropTail
			continue
		}
		key := idx
		if f.rng.Float64() < f.sched.Reorder {
			key += 1 + f.rng.IntN(max(f.sched.ReorderWindow, 1))
			f.Reordered++
		}
		f.pending = append(f.pending, faultFrame{key: key, idx: idx, data: data})
		if f.rng.Float64() < f.sched.Dup {
			f.Duplicated++
			f.pending = append(f.pending, faultFrame{key: key, idx: idx, data: data})
		}
		slices.SortStableFunc(f.pending, func(a, b faultFrame) int { return cmp.Compare(a.key, b.key) })
	}
}

// Recv returns the next frame the transport delivers. A closed source flushes
// the lag (the server wrote those frames before closing; TCP delivers them); a
// cut does not (they were in flight when the socket died).
func (f *FaultConn) Recv() ([]byte, FaultStatus) {
	f.pull()
	if len(f.pending) > 0 {
		head := f.pending[0]
		if f.closed || f.pulled > head.key+f.sched.Delay {
			f.pending = f.pending[1:]
			return head.data, FaultOK
		}
	}
	switch {
	case f.cut:
		f.pending = nil
		return nil, FaultCut
	case f.closed:
		return nil, FaultClosed
	}
	return nil, FaultEmpty
}

// Buffered counts the frames the transport still holds — preface not yet
// pulled plus pulled frames awaiting release — none of which the reader has
// seen and none of which are lost.
func (f *FaultConn) Buffered() int {
	return len(f.preface) + len(f.pending)
}

// Cut reports whether the schedule has already cut the connection: the reader
// may still drain the frames whose lag the cut satisfied, then Recv reports
// FaultCut. Anything the source writes from now on is lost.
func (f *FaultConn) Cut() bool {
	return f.cut
}

// Pull moves whatever the source holds right now into the transport, faults
// applied, releasing nothing. A harness whose queue-fill accounting must not
// depend on when frames were written (hub_sim_test.go's attach) calls it.
func (f *FaultConn) Pull() {
	f.pull()
}

// ─── tests ───────────────────────────────────────────────────────────────────

func faultFrames(n int) [][]byte {
	out := make([][]byte, n)
	for i := range n {
		out[i] = []byte{byte(i)}
	}
	return out
}

func faultDrain(f *FaultConn) (frames []byte, last FaultStatus) {
	for {
		data, st := f.Recv()
		if st != FaultOK {
			return frames, st
		}
		frames = append(frames, data[0])
	}
}

func TestFaultConn_IdentityAndDeterminism(t *testing.T) {
	in := faultFrames(20)
	got, st := faultDrain(newFaultConn(1, 0, FaultSchedule{}, in, nil))
	if st != FaultClosed || len(got) != 20 {
		t.Fatalf("identity schedule: %d frames, status %d; want 20, FaultClosed", len(got), st)
	}
	for i, b := range got {
		if int(b) != i {
			t.Fatalf("identity schedule reordered: frame %d is %d", i, b)
		}
	}

	sched := FaultSchedule{Drop: 0.2, Dup: 0.2, Reorder: 0.3, ReorderWindow: 3, Delay: 1}
	a, _ := faultDrain(newFaultConn(7, 1, sched, in, nil))
	b, _ := faultDrain(newFaultConn(7, 1, sched, in, nil))
	c, _ := faultDrain(newFaultConn(8, 1, sched, in, nil))
	d, _ := faultDrain(newFaultConn(7, 2, sched, in, nil))
	if !slices.Equal(a, b) {
		t.Fatalf("same seed and stream, different output:\n%v\n%v", a, b)
	}
	if slices.Equal(a, c) || slices.Equal(a, d) {
		t.Fatalf("a different seed (7 vs 8) or stream (1 vs 2) produced the same schedule %v", a)
	}
}

func TestFaultConn_Schedule(t *testing.T) {
	in := faultFrames(20)

	t.Run("drop all", func(t *testing.T) {
		f := newFaultConn(1, 0, FaultSchedule{Drop: 1}, in, nil)
		got, st := faultDrain(f)
		if len(got) != 0 || st != FaultClosed || f.Dropped != 20 {
			t.Fatalf("got %d frames, status %d, dropped %d; want 0, FaultClosed, 20", len(got), st, f.Dropped)
		}
	})
	t.Run("drop tail cuts", func(t *testing.T) {
		f := newFaultConn(3, 0, FaultSchedule{Drop: 0.15, DropTail: true}, in, nil)
		got, st := faultDrain(f)
		if st != FaultCut || f.Dropped != 1 || len(got) >= 20 {
			t.Fatalf("got %d frames, status %d, dropped %d; want a prefix, FaultCut, 1", len(got), st, f.Dropped)
		}
		for i, b := range got {
			if int(b) != i {
				t.Fatalf("prefix before the cut is not in order: %v", got)
			}
		}
		if _, again := f.Recv(); again != FaultCut {
			t.Fatalf("a cut connection must stay cut, got %d", again)
		}
	})
	t.Run("dup", func(t *testing.T) {
		f := newFaultConn(1, 0, FaultSchedule{Dup: 1}, in, nil)
		got, _ := faultDrain(f)
		if len(got) != 40 || f.Duplicated != 20 {
			t.Fatalf("got %d frames, duplicated %d; want 40, 20", len(got), f.Duplicated)
		}
		for i := 0; i < 40; i += 2 {
			if got[i] != got[i+1] || int(got[i]) != i/2 {
				t.Fatalf("duplicates are not adjacent and in order: %v", got)
			}
		}
	})
	t.Run("reorder is a bounded permutation", func(t *testing.T) {
		// Half the frames: pushing every frame back keeps their keys sorted
		// and the order intact — a reorder needs an unpushed neighbour.
		f := newFaultConn(5, 0, FaultSchedule{Reorder: 0.5, ReorderWindow: 2}, in, nil)
		got, _ := faultDrain(f)
		sorted := slices.Clone(got)
		slices.Sort(sorted)
		if !slices.Equal(sorted, in2bytes(in)) {
			t.Fatalf("reorder lost or invented frames: %v", got)
		}
		if slices.Equal(got, in2bytes(in)) || f.Reordered == 0 {
			t.Fatalf("Reorder=0.5 left the order intact (%d pushed): %v", f.Reordered, got)
		}
		for i, b := range got {
			if int(b) > i+2 || int(b) < i-2 {
				t.Fatalf("frame %d moved more than the window: position %d", b, i)
			}
		}
	})
	t.Run("delay lags an open source and flushes on close", func(t *testing.T) {
		ch := make(chan []byte, 8)
		f := newFaultConn(1, 0, FaultSchedule{Delay: 2}, nil, ch)
		for _, fr := range faultFrames(5) {
			ch <- fr
		}
		got, st := faultDrain(f)
		if st != FaultEmpty || len(got) != 3 || f.Buffered() != 2 {
			t.Fatalf("open source: got %d frames, status %d, buffered %d; want 3, FaultEmpty, 2", len(got), st, f.Buffered())
		}
		close(ch)
		rest, st := faultDrain(f)
		if st != FaultClosed || len(rest) != 2 || rest[0] != 3 || rest[1] != 4 {
			t.Fatalf("closed source: got %v, status %d; want [3 4], FaultClosed", rest, st)
		}
	})
	t.Run("cut loses the lag", func(t *testing.T) {
		// One frame per Recv so the schedule can be switched between pulls:
		// frames 0 and 1 arrive intact, frame 2 is the cut. With Delay 2 the
		// cut satisfies frame 0's lag but not frame 1's — it was in flight.
		ch := make(chan []byte, 1)
		f := newFaultConn(1, 0, FaultSchedule{Delay: 2, DropTail: true}, nil, ch)
		var got []byte
		for i := range 3 {
			f.sched.Drop = 0
			if i == 2 {
				f.sched.Drop = 1
			}
			ch <- []byte{byte(i)}
			if data, st := f.Recv(); st == FaultOK {
				got = append(got, data[0])
			}
		}
		_, st := f.Recv()
		if st != FaultCut || !slices.Equal(got, []byte{0}) {
			t.Fatalf("got %v, status %d; want [0] then FaultCut (frame 1 was in flight)", got, st)
		}
	})
}

func in2bytes(in [][]byte) []byte {
	out := make([]byte, len(in))
	for i, fr := range in {
		out[i] = fr[0]
	}
	return out
}
