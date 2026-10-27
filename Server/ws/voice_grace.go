package ws

// voice_grace.go — RT-8: the reconnect grace window.
//
// A clean close ends the read loop before a replacement socket arrives: a
// Wi-Fi roam, a VPN reconnect or a NAT rebind resets the TCP path and the
// server observes the close, while the LiveKit media path — an independent
// UDP flow — was never interrupted. The pre-RT-8 teardown ran
// handleVoiceLeave on that close unless a replacement had ALREADY registered
// (serve_pumps.go), so a blip shorter than the reconnect race dropped the
// call and forced a manual rejoin plus a fresh key exchange for the room.
//
// The grace window holds a COMPLETED membership — DB row, SFU participant and
// key holder — for voiceGraceWindow after the socket drops. A resuming socket
// (lastSeq > 0) that registers inside the window inherits the parked
// membership through registerNow, exactly as it inherits a still-registered
// old client's session; nothing is torn down and the media resumes. When the
// window expires first the parked membership is torn down through the same
// finishVoiceLeave the immediate path used, so the invariant is unchanged.
//
// Only a completed join is parked: an incomplete one (a join committed to the
// DB but still racing its own supersession guards, OC-0270) has no delivered
// membership to preserve, so it is left immediately.

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// voiceGraceWindow is RT-8's reconnect grace (see the file comment). 15 s
// covers a typical roam and stays well under the 60 s stale sweep, so the
// sweep's backstop still reaps a membership whose client never returns. A var
// so tests can shrink it (the staleClientTimeout / pingInterval pattern).
var voiceGraceWindow = 15 * time.Second

// voiceGraceEntry is one parked membership: the disconnected socket (for the
// teardown's log line and username) and the slotSnap it held, whose E2EE key
// must survive with it (the client keeps its keypair across a blip and only
// re-announces on a LiveKit reconnect). The snap is immutable once parked.
type voiceGraceEntry struct {
	client *Client
	snap   slotSnap
	timer  *time.Timer
}

// voiceGraceState is the userID -> parked membership map. A second drop while
// the first is still parked replaces the entry (and stops its timer), so a
// user can never have two windows pending.
type voiceGraceState struct {
	mu      syncutil.Ranked[lockRankLeaf]
	entries map[int64]*voiceGraceEntry
	closed  bool // set by close at shutdown: put arms nothing from then on
	// moved remembers, per device session, a parked call another device took
	// over (voiceJoinMoveCall): the parking session was never told, so it is
	// told when it next registers. Entries are consumed by takeMoved, dropped
	// when stale (movedNoteTTL) and capped (movedNoteCap).
	moved map[movedKey]movedNote
	// expiring counts expiry teardowns past takeForExpiry, so close can wait
	// for one already writing to the database.
	expiring sync.WaitGroup
}

// movedKey names the device session a moved-away parked call belonged to.
type movedKey struct {
	userID    int64
	tokenHash string
}

// movedNote is the channel of the call that was moved away, and when.
type movedNote struct {
	chID int64
	at   time.Time
}

const (
	// movedNoteTTL bounds how long a session may be away and still be told its
	// parked call moved; past it the client has long since given the call up.
	movedNoteTTL = 10 * time.Minute
	movedNoteCap = 1024
)

// markMoved records that tokenHash's parked call in chID was moved to another
// device.
func (s *voiceGraceState) markMoved(userID int64, tokenHash string, chID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if s.moved == nil {
		s.moved = map[movedKey]movedNote{}
	}
	for k, n := range s.moved {
		if now.Sub(n.at) > movedNoteTTL {
			delete(s.moved, k)
		}
	}
	if len(s.moved) >= movedNoteCap {
		clear(s.moved)
	}
	s.moved[movedKey{userID, tokenHash}] = movedNote{chID: chID, at: now}
}

// takeMoved returns and clears the moved-call channel for the session, or 0.
func (s *voiceGraceState) takeMoved(userID int64, tokenHash string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := movedKey{userID, tokenHash}
	n, ok := s.moved[k]
	if !ok {
		return 0
	}
	delete(s.moved, k)
	if time.Since(n.at) > movedNoteTTL {
		return 0
	}
	return n.chID
}

// isClosed reports whether close has run.
func (s *voiceGraceState) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// close stops every parked entry's timer and drops the entries, without any
// teardown or database write, and refuses all later put calls. A timer that
// already fired and is waiting on the member lock finds its entry gone
// (takeForExpiry) and does nothing; one whose teardown already started is
// waited for, so no expiry writes after close returns.
func (s *voiceGraceState) close() {
	s.mu.Lock()
	s.closed = true
	clear(s.moved)
	for uid, e := range s.entries {
		e.timer.Stop()
		delete(s.entries, uid)
	}
	s.mu.Unlock()
	s.expiring.Wait()
}

// put parks e for userID and starts its expiry timer under the lock, so no
// reader ever sees the entry without its timer. It reports false, parking
// nothing and arming no timer, after close.
func (s *voiceGraceState) put(userID int64, e *voiceGraceEntry, expire func()) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	if s.entries == nil {
		s.entries = map[int64]*voiceGraceEntry{}
	}
	if old := s.entries[userID]; old != nil {
		old.timer.Stop()
	}
	e.timer = time.AfterFunc(voiceGraceWindow, expire)
	s.entries[userID] = e
	return true
}

// get returns userID's parked entry, or nil. Its snap is immutable once
// parked, so the caller may read it without the lock.
func (s *voiceGraceState) get(userID int64) *voiceGraceEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.entries[userID]
}

// take removes and returns the parked entry for userID, or nil. It stops the
// entry's timer, so a resuming socket that inherits the membership does not
// also get the expiry teardown.
func (s *voiceGraceState) take(userID int64) *voiceGraceEntry {
	return s.takeJoin(userID, 0, "")
}

// takeJoin is take limited to an entry parking a join in channelID with
// joinToken; a zero channelID or an empty joinToken matches any.
func (s *voiceGraceState) takeJoin(userID, channelID int64, joinToken string) *voiceGraceEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[userID]
	if e == nil || (channelID != 0 && e.snap.chID != channelID) || (joinToken != "" && e.snap.joinToken != joinToken) {
		return nil
	}
	delete(s.entries, userID)
	e.timer.Stop()
	return e
}

// takeIfSame removes userID's entry only while it is still e, so a timer from
// a superseded window never tears down a newer session.
func (s *voiceGraceState) takeIfSame(userID int64, e *voiceGraceEntry) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.entries[userID] != e {
		return false
	}
	delete(s.entries, userID)
	e.timer.Stop()
	return true
}

// takeForExpiry is takeIfSame for the expiry timer, also counting the
// teardown in flight; the caller calls s.expiring.Done when it ends.
func (s *voiceGraceState) takeForExpiry(userID int64, e *voiceGraceEntry) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.entries[userID] != e {
		return false
	}
	delete(s.entries, userID)
	e.timer.Stop()
	s.expiring.Add(1)
	return true
}

// has reports whether userID has a parked membership for channelID.
func (s *voiceGraceState) has(userID, channelID int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[userID]
	return e != nil && e.snap.chID == channelID
}

// snapshot copies the parked (userID -> channelID) pairs so a caller can skip
// them without holding this lock while taking the hub lock.
func (s *voiceGraceState) snapshot() map[int64]int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[int64]int64, len(s.entries))
	for uid, e := range s.entries {
		out[uid] = e.snap.chID
	}
	return out
}

// disconnectVoice is the socket-teardown voice step (readPump and a failed
// handshake), run under the teardown's own txn. A completed membership is
// parked in the grace window (voiceTxn.park); anything else (disabled window,
// a failed/half join, a kick that refuses reconnection) leaves immediately.
func (h *Hub) disconnectVoice(ctx context.Context, txn *voiceTxn, c *Client, reason string) {
	snap, handled := txn.park(c) //nolint:contextcheck // the grace timer outlives the disconnect ctx; expiry uses its own.
	if handled {
		return
	}
	h.finishVoiceLeave(ctx, txn, c, snap.chID, snap.joinToken, reason)
}

// park clears c's slot and parks a COMPLETED membership in the grace window,
// reporting whether nothing is left for the caller to tear down: the slot held
// no membership, the membership is parked, or the registry is closed (shutdown;
// the slot is cleared, no timer is armed and nothing is written to the
// database, whatever the membership's state: the next boot wipes the rows).
// When it reports false the membership was not parkable (an
// incomplete join, a disabled window, a kick that refuses reconnection), and
// the caller leaves immediately with the returned snap.
//
// The timer outlives the disconnect ctx; expiry runs the teardown under its own
// context and the member lock, and drops the entry first (expireVoiceGrace).
func (t *voiceTxn) park(c *Client) (slotSnap, bool) {
	snap := t.clear(c)
	if snap.chID == 0 {
		return snap, true
	}
	h := t.h
	if h.voiceReg.voiceGrace.isClosed() {
		slog.Debug("voice leave dropped: hub is stopping",
			"user_id", c.userID, "channel_id", snap.chID)
		return snap, true
	}
	if !snap.completed || voiceGraceWindow <= 0 || c.isTerminallyKicked() {
		return snap, false
	}
	entry := &voiceGraceEntry{client: c, snap: snap}
	if !h.voiceReg.voiceGrace.put(c.userID, entry, func() { //nolint:contextcheck // the timer outlives the disconnect ctx; expiry uses its own.
		h.expireVoiceGrace(c.userID, entry)
	}) {
		return snap, true // closed between the check above and the put
	}
	slog.Info("voice leave deferred (grace window)",
		"user_id", c.userID, "channel_id", snap.chID,
		"grace_ms", voiceGraceWindow.Milliseconds())
	return snap, true
}

// expireVoiceGrace tears down a parked membership whose window elapsed. Under
// the member lock it takes the entry back only if it is still this one
// (takeForExpiry), so exactly one of this teardown and a resuming socket's
// voiceTxn.inherit runs when the two land together, and a superseded window's
// timer never tears down a newer session. The entry is removed before the
// slow finishVoiceLeave, which never runs with the grace lock held.
func (h *Hub) expireVoiceGrace(userID int64, entry *voiceGraceEntry) {
	txn := h.begin(userID)
	defer txn.end()
	if !h.voiceReg.voiceGrace.takeForExpiry(userID, entry) {
		return
	}
	defer h.voiceReg.voiceGrace.expiring.Done()
	h.leaveParkedVoice(context.Background(), txn, entry, voiceLeaveReasonGraceExpired)
}

// leaveParkedVoice runs the full voice teardown for a parked membership
// already taken from the grace window, reporting false for a nil entry.
// The caller holds Hub.begin for the entry's user.
func (h *Hub) leaveParkedVoice(ctx context.Context, txn *voiceTxn, e *voiceGraceEntry, reason string) bool {
	if e == nil {
		return false
	}
	h.finishVoiceLeave(ctx, txn, e.client, e.snap.chID, e.snap.joinToken, reason)
	return true
}

// dropOrphanVoiceGrace drops userID's parked membership when its exact
// voice_states row (channel and joined_at) is gone, so a resume never
// inherits a membership with no row. A failed read keeps the entry.
func (h *Hub) dropOrphanVoiceGrace(ctx context.Context, userID int64) {
	e := h.voiceReg.voiceGrace.get(userID)
	if e == nil {
		return
	}
	row, err := h.voice.State(ctx, userID)
	if err != nil || (row != nil && row.ChannelID == e.snap.chID && row.JoinedAt == e.snap.joinToken) {
		return
	}
	if h.voiceReg.voiceGrace.takeIfSame(userID, e) {
		slog.Info("voice grace dropped: its voice state row is gone",
			"user_id", userID, "channel_id", e.snap.chID)
	}
}

// inherit is registerNow's RT-8 step: a resuming socket (lastSeq > 0)
// inherits the voice membership its previous socket parked in the grace window
// when it dropped, so a short network blip keeps the call instead of ending it.
// The parked snap carries the completed join's token and E2EE key; adopting it
// lets registerNow's subscribe block restore the voice topic exactly as the
// still-registered-old-client transfer does. Taking the entry stops its expiry
// timer, and expireVoiceGrace's takeForExpiry under the same member lock finds it
// gone, so inheriting and tearing down can never both run. It returns the
// inherited channel id, or 0.
//
// Only the same session (token hash) inherits or discards a parked entry.
//
// Skipped when the old-client transfer already supplied a session (c is in a
// voice channel) — a reconnect that beat the drop teardown. A fresh connect
// (lastSeq == 0) is a deliberate reload rather than a blip, so it discards any
// parked entry instead.
func (t *voiceTxn) inherit(c *Client) int64 {
	// Only the session that parked the call may take it back. Another device's
	// parked call stays parked for its own device (and expires on its own):
	// this connection just joins alongside it.
	e := t.h.voiceReg.voiceGrace.get(c.userID)
	if e == nil || e.client.tokenHash != c.tokenHash {
		return 0
	}
	if c.lastSeq == 0 {
		t.takeParked(0) // the entry is this session's (checked above)
		return 0
	}
	if c.voice.channel() != 0 {
		return 0
	}
	e = t.takeParked(0)
	if e == nil || !t.adoptParked(c, e.snap) {
		return 0
	}
	slog.Info("hub: resumed connection inherited the grace-window voice membership",
		"user_id", c.userID, "channel_id", e.snap.chID)
	return e.snap.chID
}
