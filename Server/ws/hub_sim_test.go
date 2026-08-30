package ws_test

// hub_sim_test.go — B3-6 item 2: a seeded simulation of the hub's ordering
// space (Tier 3b of docs/plans/bug-detection-improvements.md). Every recurring
// bug in this package's history is a bad ordering — registerNow's
// reconnect-transfer, replay against a moving ring, a socket dying with
// frames in flight — and nothing else in the repo generates orderings. This
// does: a PCG stream picks each step from {subscribe, broadcast, ack,
// disconnect, reconnect-transfer} over eight headless clients on a real Hub,
// and a model client checks the oracle below after every step.
//
// ORACLE — written before the driver, from Server/CLAUDE.md ("Sequenced
// frames share one per-client FIFO because clients ack only max(seq) — a
// frame that skips the queue, or a seq allocated for a frame that is then
// dropped, is silently unrecoverable") and the replay semantics pinned by
// ringbuffer_test.go, hub_register_race_test.go and serve.go's
// reconnectRegister. The only ack this protocol has is last_seq on the next
// auth frame, so "ack" here is the client reading frames and advancing its
// watermark W = max(seq read).
//
//	I1  Within one connection, sequenced frames arrive with strictly
//	    increasing seq — the replay burst first, then the live queue — and a
//	    seq-stamped frame never rides the high- or low-priority queue.
//	I2  A live connection yields, in order, exactly the seqs the hub allocated
//	    for events whose audience contained it since it registered: nothing
//	    missing (a seq allocated for a frame that was then dropped is a gap),
//	    nothing extra, nothing twice. After every step the frames still
//	    unread (queue + transport) equal the seqs still owed.
//	I3  On a resume from W that the ring covers, the replay burst is exactly
//	    {s in (W, S] : channel(s) is 0 or READ-allowed}, in seq order, where
//	    S is the hub seq at the instant registerNow ran (atomic with the
//	    snapshot under h.seqMu), and every audience seq above S arrives live —
//	    so across a drop and a resume no audience seq above W is lost or
//	    skipped. Frames the dying socket still held above W are delivered
//	    again by the replay; that cross-connection duplicate is by design
//	    (the client acks max(seq)) and I1 still holds per connection.
//	I4  h.seq advances only for a frame that reached the ring: a
//	    topic-limiter shed allocates nothing, and after every allocation
//	    ring.NewestSeq() == h.seq.
//	I5  When the ring cannot cover W the resume is refused a replay
//	    (ok=false), the connection is registered the way handleFreshConnect
//	    registers a replay-failure fallback, and the obligations restart
//	    there — a full ready carries the state.
//	I6  A dead socket's late teardown (unregisterNow after its replacement
//	    registered) reports replaced=true and leaves the replacement in
//	    place; tearing down the live connection reports false.
//
// Audience: a global broadcast reaches every registered client; a channel
// broadcast the clients focused on it (after the topic limiter); a
// recipients-scoped broadcast (voice_state's path) exactly its listed users;
// a sequenced DM its participants. The replay filter is coarser than the
// audience — it replays every READ-allowed channel, focused or not — so a
// resume legitimately carries frames the client would not have received live.
//
// Knobs: OWNCORD_SIM_SEED replays one seed; OWNCORD_SIM_SEEDS (default 20)
// and OWNCORD_SIM_STEPS (default 200) size a run; `make sim` runs 10,000
// steps. A failure prints the seed, the step, a ready-to-paste replay line
// and the last steps. The step sequence is a pure function of the seed; the
// scheduler's interleaving inside a racing reconnect step is not, and every
// assertion is written to hold for any interleaving.

import (
	"fmt"
	"math/rand/v2"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

const (
	simClients      = 8
	simChannels     = 3
	simRing         = 48 // replay ring (production 1000): small enough that I5's eviction is reachable in 200 steps
	simSendBuf      = 32 // normal queue (production 256, client.go sendBufSize): small enough that the BUG-124 overflow kick is reachable in 200 steps
	simDefaultSeeds = 20
	simDefaultSteps = 200
)

type simOp int

const (
	opSubscribe simOp = iota
	opBroadcast
	opAck
	opDisconnect
	opReconnect
)

var simOpWeights = [...]int{opSubscribe: 15, opBroadcast: 40, opAck: 20, opDisconnect: 10, opReconnect: 15}

type simKind int

const (
	kindGlobal simKind = iota
	kindChannel
	kindRecipients
	kindDM
)

var (
	simKindNames   = [...]string{kindGlobal: "global", kindChannel: "channel", kindRecipients: "recipients", kindDM: "dm"}
	simKindWeights = [...]int{kindGlobal: 30, kindChannel: 35, kindRecipients: 15, kindDM: 20}
)

// simAlloc is one allocated seq and how the hub addressed it.
type simAlloc struct {
	seq   uint64
	ch    int64
	kind  simKind
	users []int64 // recipients or DM participants
}

// reaches is the live audience rule for a registered client.
func (a simAlloc) reaches(c *simClient) bool {
	switch a.kind {
	case kindGlobal:
		return true
	case kindChannel:
		return c.focus == a.ch
	default:
		return slices.Contains(a.users, c.user.ID)
	}
}

type simClient struct {
	idx     int
	user    *db.User
	allowed map[int64]bool // READ-allowed channels: every text channel plus this user's DM channels
	conn    *ws.Client     // nil while disconnected
	send    chan []byte
	high    chan []byte
	low     chan []byte
	wire    *ws.FaultConn
	conns   int
	cut     bool   // the transport cut the socket; the server has not noticed yet
	focus   int64  // focused channel, 0 = none
	w       uint64 // watermark: max seq read
	owed    []uint64
}

type sim struct {
	t       *testing.T
	hub     *ws.Hub
	rng     *rand.Rand
	seed    uint64
	steps   int
	step    int
	chIDs   []int64
	clients []*simClient
	chanOf  []int64 // chanOf[seq] = channel of every allocated seq; index 0 unused
	sched   ws.FaultSchedule
	trace   []string
	stats   map[string]int
}

func TestHubSimulation(t *testing.T) {
	seeds, steps := simConfig(t)
	for _, seed := range seeds {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) { runHubSim(t, seed, steps) })
	}
}

func simConfig(t *testing.T) (seeds []uint64, steps int) {
	t.Helper()
	steps = simEnvInt(t, "OWNCORD_SIM_STEPS", simDefaultSteps)
	if v := os.Getenv("OWNCORD_SIM_SEED"); v != "" {
		seed, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			t.Fatalf("OWNCORD_SIM_SEED=%q: %v", v, err)
		}
		return []uint64{seed}, steps
	}
	for i := range simEnvInt(t, "OWNCORD_SIM_SEEDS", simDefaultSeeds) {
		seeds = append(seeds, uint64(i+1))
	}
	return seeds, steps
}

func simEnvInt(t *testing.T, name string, def int) int {
	t.Helper()
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		t.Fatalf("%s=%q: want a positive integer", name, v)
	}
	return n
}

func simDMChannel(i, j int) int64 {
	return 1000 + int64(min(i, j))*simClients + int64(max(i, j))
}

func runHubSim(t *testing.T, seed uint64, steps int) {
	hub, database := newTestHub(t)
	hub.ConfigureReplay(simRing, 0)
	s := &sim{
		t: t, hub: hub, seed: seed, steps: steps,
		rng:    rand.New(rand.NewPCG(seed, seed^0xD1B54A32D192ED03)),
		chanOf: []int64{0},
		stats:  map[string]int{},
	}
	for i := range simChannels {
		s.chIDs = append(s.chIDs, seedTestChannel(t, database, fmt.Sprintf("sim-%d", i)))
	}
	for i := range simClients {
		c := &simClient{idx: i, user: seedOwnerUser(t, database, fmt.Sprintf("sim-user-%d", i)), allowed: map[int64]bool{}}
		for _, ch := range s.chIDs {
			c.allowed[ch] = true
		}
		for j := range simClients {
			if j != i {
				c.allowed[simDMChannel(i, j)] = true
			}
		}
		s.clients = append(s.clients, c)
	}
	// The wire: an order-preserving lag and the one fault TCP really has, a cut.
	s.sched = ws.FaultSchedule{Delay: s.rng.IntN(3), Drop: 0.02, DropTail: true}
	for _, c := range s.clients {
		s.connect(c)
	}
	for s.step = 1; s.step <= steps; s.step++ {
		c := s.clients[s.rng.IntN(simClients)]
		switch simOp(s.pick(simOpWeights[:])) {
		case opSubscribe:
			s.subscribe(c)
		case opBroadcast:
			s.broadcast(nil)
		case opAck:
			s.ack(c)
		case opDisconnect:
			s.disconnect(c)
		case opReconnect:
			s.reconnect(c)
		}
		s.checkCounts()
	}
	for _, c := range s.clients {
		if c.conn != nil && !c.cut {
			s.read(c, -1)
		}
	}
	t.Logf("seed %d: %d steps, seq %d, %v", seed, steps, hub.SeqForTest(), s.stats)
}

func (s *sim) pick(weights []int) int {
	total := 0
	for _, w := range weights {
		total += w
	}
	r := s.rng.IntN(total)
	for i, w := range weights {
		if r < w {
			return i
		}
		r -= w
	}
	return len(weights) - 1
}

func (s *sim) note(format string, args ...any) {
	s.trace = append(s.trace, fmt.Sprintf("#%d ", s.step)+fmt.Sprintf(format, args...))
	if len(s.trace) > 24 {
		s.trace = s.trace[1:]
	}
}

func (s *sim) failf(format string, args ...any) {
	s.t.Helper()
	s.t.Fatalf("hub simulation: seed %d step %d: %s\nreplay: OWNCORD_SIM_SEED=%d OWNCORD_SIM_STEPS=%d go test -race -count=1 -run '^TestHubSimulation$' ./ws/\nlast steps:\n  %s",
		s.seed, s.step, fmt.Sprintf(format, args...), s.seed, s.steps, strings.Join(s.trace, "\n  "))
}

// ─── connections ─────────────────────────────────────────────────────────────

func (s *sim) newConn(c *simClient, channelID int64, lastSeq uint64) *ws.Client {
	c.send = make(chan []byte, simSendBuf)
	c.high = make(chan []byte, 64)
	c.low = make(chan []byte, 64)
	return ws.NewSimClientForTest(s.hub, c.user, channelID, lastSeq, c.send, c.high, c.low)
}

func (s *sim) attach(c *simClient, conn *ws.Client, preface [][]byte, owed []uint64) {
	c.conns++
	c.conn, c.cut, c.owed = conn, false, owed
	c.wire = ws.NewFaultConnForTest(s.seed*7919+uint64(c.idx)*131+uint64(c.conns), s.sched, preface, c.send)
	if got := s.hub.GetClient(c.user.ID); got != conn {
		s.failf("c%d: hub holds %p for the user after registration, want %p", c.idx, got, conn)
	}
}

// connect is a fresh connect (last_seq 0): handleFreshConnect registers with
// a nil readable set, so nothing is inherited and there is no replay.
func (s *sim) connect(c *simClient) {
	conn := s.newConn(c, 0, 0)
	s.hub.RegisterNowForTest(conn)
	c.focus = 0
	s.attach(c, conn, nil, nil)
}

// teardownOld is the replaced socket's readPump defer finishing late (I6).
func (s *sim) teardownOld(c *simClient, old *ws.Client) {
	if old != nil && !s.hub.UnregisterNowForTest(old) {
		s.failf("I6: c%d: the replaced connection's teardown evicted the replacement", c.idx)
	}
}

// ─── steps ───────────────────────────────────────────────────────────────────

func (s *sim) subscribe(c *simClient) {
	// A queue the server already closed (overflow kick, read as FaultClosed
	// at the next ack) is a dying socket: Subscribe refuses it by design, and
	// the client is not sending channel_focus on it anyway.
	if c.conn == nil || c.cut || ws.IsSendClosedForTest(c.conn) {
		s.note("subscribe c%d: no live connection", c.idx)
		return
	}
	var ch int64
	if s.rng.IntN(4) != 0 {
		ch = s.chIDs[s.rng.IntN(simChannels)]
	}
	s.hub.ApplySetChannelIDForTest(c.conn, ch)
	c.focus = ch
	if got := ws.ClientChannelIDForTest(c.conn); got != ch || (ch != 0 && !s.hub.SubscribedToChannelTopicForTest(c.conn, ch)) {
		s.failf("channel_focus %d left c%d focused on %d", ch, c.idx, got)
	}
	s.note("subscribe c%d -> ch%d", c.idx, ch)
}

// broadcast allocates one seq through the real delivery path and records who
// is owed it. exclude is a client mid-reconnect whose audience the caller
// resolves itself.
func (s *sim) broadcast(exclude *simClient) simAlloc {
	a := simAlloc{kind: simKind(s.pick(simKindWeights[:]))}
	payload := fmt.Appendf(nil, `{"type":"sim","step":%d}`, s.step)
	before := s.hub.SeqForTest()
	switch a.kind {
	case kindGlobal:
		a.seq = s.hub.DeliverBroadcastForTest(0, nil, payload)
	case kindChannel:
		a.ch = s.chIDs[s.rng.IntN(simChannels)]
		a.seq = s.hub.DeliverBroadcastForTest(a.ch, nil, payload)
	case kindRecipients:
		a.ch = s.chIDs[s.rng.IntN(simChannels)]
		a.users = make([]int64, 0, simClients)
		for _, c := range s.clients {
			if s.rng.IntN(2) == 0 {
				a.users = append(a.users, c.user.ID)
			}
		}
		a.seq = s.hub.DeliverBroadcastForTest(a.ch, a.users, payload)
	case kindDM:
		i := s.rng.IntN(simClients)
		j := (i + 1 + s.rng.IntN(simClients-1)) % simClients
		a.ch = simDMChannel(i, j)
		a.users = []int64{s.clients[i].user.ID, s.clients[j].user.ID}
		a.seq = s.hub.SendSequencedToUsersForTest(a.ch, a.users, payload)
	}
	after := s.hub.SeqForTest()
	switch {
	case a.seq == 0 && after != before:
		s.failf("I4: a shed %s frame advanced seq %d -> %d", simKindNames[a.kind], before, after)
	case a.seq == 0:
		s.stats["shed"]++
		s.note("broadcast %s ch%d: shed by the topic limiter", simKindNames[a.kind], a.ch)
		return a
	case after != a.seq || s.hub.ReplayBuffer().NewestSeq() != a.seq:
		s.failf("I4: seq %d allocated but ring newest is %d (hub seq %d)", a.seq, s.hub.ReplayBuffer().NewestSeq(), after)
	case uint64(len(s.chanOf)) != a.seq:
		s.failf("I4: seq %d is not the successor of %d", a.seq, len(s.chanOf)-1)
	}
	s.chanOf = append(s.chanOf, a.ch)
	for _, c := range s.clients {
		if c != exclude && c.conn != nil && !c.cut && a.reaches(c) {
			c.owed = append(c.owed, a.seq)
		}
	}
	s.stats[simKindNames[a.kind]]++
	s.note("broadcast %s ch%d users%v -> seq %d", simKindNames[a.kind], a.ch, a.users, a.seq)
	return a
}

func (s *sim) ack(c *simClient) {
	if c.conn == nil || c.cut {
		s.note("ack c%d: no live connection", c.idx)
		return
	}
	n := 1 + s.rng.IntN(8)
	if s.rng.IntN(2) == 0 {
		n = -1 // drain
	}
	s.read(c, n)
}

// read pulls up to n frames (n < 0: until the wire is empty) through the
// transport and checks each against the model.
func (s *sim) read(c *simClient, n int) {
	defer s.checkPriorityQueues(c)
	read := 0
	for n < 0 || read < n {
		frame, st := c.wire.Recv()
		if st == ws.FaultOK {
			s.observe(c, frame)
			read++
			continue
		}
		switch st {
		case ws.FaultEmpty:
			if len(c.owed) != c.wire.Buffered() {
				s.failf("I2: c%d conn %d: owed %v but only %d unread frame(s) remain (W=%d)", c.idx, c.conns, c.owed, c.wire.Buffered(), c.w)
			}
			s.note("ack c%d: read %d, W=%d, %d in flight", c.idx, read, c.w, c.wire.Buffered())
		case ws.FaultClosed:
			// The server closed the queue: the normal-queue overflow kick
			// (client.go sendMsg, BUG-124). Its readPump defer follows.
			if !ws.IsSendClosedForTest(c.conn) || s.hub.UnregisterNowForTest(c.conn) {
				s.failf("I6: c%d: queue reported closed on a live connection, or its teardown reported replaced", c.idx)
			}
			c.conn, c.owed = nil, nil
			s.stats["kicked"]++
			s.note("ack c%d: read %d then the server had closed the queue (overflow kick), W=%d", c.idx, read, c.w)
		case ws.FaultCut:
			c.cut, c.owed = true, nil
			s.stats["cut"]++
			s.note("ack c%d: read %d then the wire cut, W=%d", c.idx, read, c.w)
		}
		return
	}
	s.note("ack c%d: read %d, W=%d", c.idx, read, c.w)
}

func (s *sim) disconnect(c *simClient) {
	if c.conn == nil {
		s.note("disconnect c%d: already gone", c.idx)
		return
	}
	if s.hub.UnregisterNowForTest(c.conn) || s.hub.GetClient(c.user.ID) != nil {
		s.failf("I6: c%d: tearing down the live connection reported replaced or left a client registered", c.idx)
	}
	ws.CloseSendForTest(c.conn)
	c.conn, c.owed, c.cut = nil, nil, false
	s.note("disconnect c%d (W=%d)", c.idx, c.w)
}

// reconnect is the resume: a new socket for the same user carrying W as
// last_seq, registered through reconnectRegister — the replay snapshot and
// registerNow under one h.seqMu section — while up to three broadcasts race
// it from this goroutine, exactly the interleaving the seqMu discipline
// exists for. The old socket may still be registered (a network blip: the
// transfer path) or already gone (active_channel_id restores the focus).
func (s *sim) reconnect(c *simClient) {
	old := c.conn
	if c.w == 0 {
		s.connect(c)
		s.teardownOld(c, old)
		s.stats["fresh"]++
		s.note("reconnect c%d: fresh (W=0)", c.idx)
		return
	}
	var authCh int64
	if old == nil {
		authCh = c.focus
	}
	conn := s.newConn(c, authCh, c.w)
	s0 := s.hub.SeqForTest()
	var (
		events [][]byte
		ok     bool
		done   = make(chan struct{})
	)
	go func() {
		defer close(done)
		events, ok = s.hub.ReconnectRegisterForTest(conn, c.w, c.allowed)
	}()
	var racing []simAlloc
	for range s.rng.IntN(4) {
		if a := s.broadcast(c); a.seq != 0 {
			racing = append(racing, a)
		}
	}
	<-done
	var owed []uint64
	if ok {
		owed = s.checkReplay(c, events, s0, racing)
		s.stats["resume"]++
	} else {
		if s.hub.ReplayBuffer().EventsSinceFiltered(c.w, c.allowed) != nil {
			s.failf("I5: c%d: replay refused although the ring (oldest %d) covers W=%d", c.idx, s.hub.ReplayBuffer().OldestSeq(), c.w)
		}
		// handleFreshConnect's replay-failure fallback: registerNow with the
		// readable set, so the focus still transfers; a full ready follows.
		s.hub.RegisterNowWithReadableForTest(conn, c.allowed)
		events = nil
		s.stats["fallback"]++
	}
	s.teardownOld(c, old)
	s.attach(c, conn, events, owed)
	if got := ws.ClientChannelIDForTest(conn); got != c.focus {
		s.failf("c%d: resumed connection focused on %d, want %d", c.idx, got, c.focus)
	}
	s.note("reconnect c%d: W=%d old=%v replay=%v racing=%d owed=%v", c.idx, c.w, old != nil, ok, len(racing), owed)
}
