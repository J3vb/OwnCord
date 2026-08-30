package ws_test

// hub_sim_oracle_test.go — the checks behind hub_sim_test.go's oracle; the
// invariants I1–I6 are stated there. Split out so the driver stays readable;
// nothing here runs on its own.

import (
	"encoding/json"
	"slices"

	"github.com/J3vb/OwnCord/Server/ws"
)

// observe is I1 and I2 for one frame read off a connection's normal queue.
func (s *sim) observe(c *simClient, frame []byte) {
	seq := simSeqOf(frame)
	switch {
	case seq == 0:
		s.failf("I1: unsequenced frame on c%d's normal queue: %s", c.idx, frame)
	case seq <= c.w:
		s.failf("I1: c%d conn %d: seq %d after watermark %d", c.idx, c.conns, seq, c.w)
	case len(c.owed) == 0:
		s.failf("I2: c%d conn %d: received seq %d but is owed nothing", c.idx, c.conns, seq)
	case c.owed[0] != seq:
		s.failf("I2: c%d conn %d: expected seq %d next, got %d (owed %v)", c.idx, c.conns, c.owed[0], seq, c.owed)
	}
	c.owed = c.owed[1:]
	c.w = seq
}

func simSeqOf(frame []byte) uint64 {
	var env struct {
		Seq uint64 `json:"seq"`
	}
	if json.Unmarshal(frame, &env) != nil {
		return 0
	}
	return env.Seq
}

// checkPriorityQueues is I1's second half: nothing sequenced may sit on the
// high or low queue, where writePump would let it overtake the FIFO.
func (s *sim) checkPriorityQueues(c *simClient) {
	for _, q := range []chan []byte{c.high, c.low} {
		for drained := false; !drained; {
			select {
			case frame, ok := <-q:
				if ok && simSeqOf(frame) != 0 {
					s.failf("I1: seq-stamped frame on c%d's priority queue: %s", c.idx, frame)
				}
				drained = !ok
			default:
				drained = true
			}
		}
	}
}

// checkReplay is I3. S is unknown when broadcasts raced the registration, so
// every candidate — the seq before the burst, then each racing seq — is tried;
// the replay burst is a prefix-closed function of S, so at most one matches,
// and the racing seqs above it are what the new connection is owed live.
func (s *sim) checkReplay(c *simClient, events [][]byte, s0 uint64, racing []simAlloc) []uint64 {
	got := make([]uint64, len(events))
	for i, e := range events {
		got[i] = simSeqOf(e)
	}
	candidates := make([]uint64, 0, 1+len(racing))
	candidates = append(candidates, s0)
	for _, a := range racing {
		candidates = append(candidates, a.seq)
	}
	for j, snap := range candidates {
		if !slices.Equal(got, s.replayExpected(c, snap)) {
			continue
		}
		owed := slices.Clone(got)
		for _, a := range racing[j:] {
			if a.reaches(c) {
				owed = append(owed, a.seq)
			}
		}
		if j > 0 {
			s.stats["racing-in-replay"]++
		}
		return owed
	}
	s.failf("I3: c%d resume from W=%d: replay %v matches no snapshot point; at S=%d it should be %v (racing seqs after that: %v)",
		c.idx, c.w, got, s0, s.replayExpected(c, s0), candidates[1:])
	return nil
}

func (s *sim) replayExpected(c *simClient, snap uint64) []uint64 {
	exp := []uint64{}
	for seq := c.w + 1; seq <= snap; seq++ {
		if ch := s.chanOf[seq]; ch == 0 || c.allowed[ch] {
			exp = append(exp, seq)
		}
	}
	return exp
}

// checkCounts is I2's after-every-step half: every live connection holds
// exactly the frames it is owed, no more and no fewer. A connection the wire
// has already cut (the client just has not read up to the cut yet) and one
// the server closed (overflow kick, read as FaultClosed later) are dead: the
// next read settles them, and a dead socket owes nothing.
func (s *sim) checkCounts() {
	for _, c := range s.clients {
		if c.conn == nil || c.cut || c.wire.Cut() || ws.IsSendClosedForTest(c.conn) {
			continue
		}
		if unread := len(c.send) + c.wire.Buffered(); unread != len(c.owed) {
			s.failf("I2: c%d conn %d holds %d unread frame(s) but is owed %d: %v", c.idx, c.conns, unread, len(c.owed), c.owed)
		}
	}
}
