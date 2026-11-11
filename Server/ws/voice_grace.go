package ws

// The reconnect grace window. A clean close ends the read loop before a replacement socket
// arrives (Wi-Fi roam, VPN reconnect, NAT rebind), while the LiveKit media path (an
// independent UDP flow) was never interrupted; leaving immediately would drop the call and
// force a manual rejoin plus a fresh key exchange. A completed membership (DB row, SFU
// participant, key holder) is held for voiceGraceWindow after the socket drops. A resuming
// socket (lastSeq > 0) registering inside it inherits it through registerNow; otherwise
// expiry tears it down through finishVoiceLeave. An incomplete join is not parked.

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// voiceGraceWindow is the reconnect grace: covers a typical roam, well under the 60 s stale
// sweep backstop. A var so tests can shrink it.
var voiceGraceWindow = 15 * time.Second

// voiceGraceEntry is one parked membership: the disconnected socket (for the teardown log)
// and its slotSnap, whose E2EE key must survive with it. The snap is immutable once parked.
type voiceGraceEntry struct {
	client *Client
	snap   slotSnap
	timer  *time.Timer
}

// voiceGraceState is the userID to parked-membership map. A second drop replaces the entry
// (and stops its timer), so a user never has two windows pending.
type voiceGraceState struct {
	mu      syncutil.Ranked[lockRankLeaf]
	entries map[int64]*voiceGraceEntry
	closed  bool // set by close at shutdown: put arms nothing from then on
	// moved remembers, per device session, a parked call another device took over
	// (voiceJoinMoveCall), to tell the parking session when it next registers. Dropped when stale
	// (movedNoteTTL) and capped (movedNoteCap).
	moved map[movedKey]movedNote
	// modMoves holds, per user, a moderator move that evicted a parked call, for the parking
	// session to collect on resume (voice_grace_modmove.go).
	modMoves map[int64]*parkedModMove
	// expiring counts expiry teardowns past takeForExpiry so close can wait for one writing to the DB.
	expiring sync.WaitGroup
}

type movedKey struct {
	userID    int64
	tokenHash string
}

type movedNote struct {
	chID int64
	at   time.Time
}

const (
	// movedNoteTTL bounds how long a session may be away and still be told its call moved.
	movedNoteTTL = 10 * time.Minute
	movedNoteCap = 1024
)

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

func (s *voiceGraceState) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// close stops every parked entry's timer and drops the entries without teardown or DB
// write, and refuses later put calls. A fired timer waiting on the member lock finds its
// entry gone; one already tearing down is waited for, so no expiry writes after close returns.
func (s *voiceGraceState) close() {
	s.mu.Lock()
	s.closed = true
	clear(s.moved)
	clear(s.modMoves)
	for uid, e := range s.entries {
		e.timer.Stop()
		delete(s.entries, uid)
	}
	s.mu.Unlock()
	s.expiring.Wait()
}

// put parks e for userID and starts its expiry timer under the lock, so no reader sees the
// entry without its timer. After close it reports false.
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

// get returns userID's parked entry or nil; its snap is immutable so reading it needs no lock.
func (s *voiceGraceState) get(userID int64) *voiceGraceEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.entries[userID]
}

// take removes and returns userID's entry, stopping its timer so an inheriting socket does not also get the
// expiry teardown.
func (s *voiceGraceState) take(userID int64) *voiceGraceEntry {
	return s.takeJoin(userID, 0, "")
}

// takeJoin is take limited to an entry parking channelID with joinToken; zero/empty matches any.
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

// takeIfSame removes userID's entry only while it is still e, so a superseded timer never tears down a newer
// session.
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

// takeForExpiry is takeIfSame for the expiry timer, also counting the teardown in flight (caller calls
// s.expiring.Done).
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

func (s *voiceGraceState) has(userID, channelID int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[userID]
	return e != nil && e.snap.chID == channelID
}

// snapshot copies the parked (userID to channelID) pairs so callers can skip them without holding this lock
// while taking the hub lock.
func (s *voiceGraceState) snapshot() map[int64]int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[int64]int64, len(s.entries))
	for uid, e := range s.entries {
		out[uid] = e.snap.chID
	}
	return out
}

// disconnectVoice is the socket-teardown voice step (readPump, failed handshake) under the
// teardown's txn. A completed membership is parked; anything else (disabled window, half
// join, a kick refusing reconnection) leaves immediately.
func (h *Hub) disconnectVoice(ctx context.Context, txn *voiceTxn, c *Client, reason string) {
	snap, handled := txn.park(c) //nolint:contextcheck // the grace timer outlives the disconnect ctx; expiry uses its own.
	if handled {
		return
	}
	h.finishVoiceLeave(ctx, txn, c, snap.chID, snap.joinToken, reason)
}

// park clears c's slot and parks a completed membership, reporting whether nothing is left
// for the caller to tear down: no membership, parked, or the registry is closed (shutdown:
// the next boot wipes the rows). False means not parkable and the caller leaves immediately
// with the returned snap. The timer outlives the disconnect ctx; expiry runs under its own
// context and the member lock, dropping the entry first (expireVoiceGrace).
func (t *voiceTxn) park(c *Client) (slotSnap, bool) {
	snap := t.clear(c)
	if snap.chID == 0 {
		return snap, true
	}
	h := t.h
	if h.voiceHub.reg.voiceGrace.isClosed() {
		slog.Debug("voice leave dropped: hub is stopping",
			"user_id", c.userID, "channel_id", snap.chID)
		return snap, true
	}
	if !snap.completed || voiceGraceWindow <= 0 || c.isTerminallyKicked() {
		return snap, false
	}
	entry := &voiceGraceEntry{client: c, snap: snap}
	if !h.voiceHub.reg.voiceGrace.put(c.userID, entry, func() { //nolint:contextcheck // the timer outlives the disconnect ctx; expiry uses its own.
		h.expireVoiceGrace(c.userID, entry)
	}) {
		return snap, true // closed between the check above and the put
	}
	slog.Info("voice leave deferred (grace window)",
		"user_id", c.userID, "channel_id", snap.chID,
		"grace_ms", voiceGraceWindow.Milliseconds())
	return snap, true
}

// expireVoiceGrace tears down a parked membership whose window elapsed. Under the member
// lock it takes the entry only if still this one (takeForExpiry), so exactly one of this
// teardown and a resuming socket's voiceTxn.inherit runs, and a superseded timer never tears
// down a newer session. The entry is removed before the slow finishVoiceLeave, which never
// runs with the grace lock held.
func (h *Hub) expireVoiceGrace(userID int64, entry *voiceGraceEntry) {
	txn := h.begin(userID)
	defer txn.end()
	if !h.voiceHub.reg.voiceGrace.takeForExpiry(userID, entry) {
		return
	}
	defer h.voiceHub.reg.voiceGrace.expiring.Done()
	h.leaveParkedVoice(context.Background(), txn, entry, voiceLeaveReasonGraceExpired)
}

// leaveParkedVoice runs the full teardown for a parked membership already taken from the
// window; false for nil. The caller holds Hub.begin for the entry's user.
func (h *Hub) leaveParkedVoice(ctx context.Context, txn *voiceTxn, e *voiceGraceEntry, reason string) bool {
	if e == nil {
		return false
	}
	h.finishVoiceLeave(ctx, txn, e.client, e.snap.chID, e.snap.joinToken, reason)
	return true
}

// dropOrphanVoiceGrace drops userID's parked membership when its exact voice_states row is
// gone, so a resume never inherits one with no row. A failed read keeps the entry.
func (h *Hub) dropOrphanVoiceGrace(ctx context.Context, userID int64) {
	e := h.voiceHub.reg.voiceGrace.get(userID)
	if e == nil {
		return
	}
	row, err := h.voice.State(ctx, userID)
	if err != nil || (row != nil && row.ChannelID == e.snap.chID && row.JoinedAt == e.snap.joinToken) {
		return
	}
	if h.voiceHub.reg.voiceGrace.takeIfSame(userID, e) {
		slog.Info("voice grace dropped: its voice state row is gone",
			"user_id", userID, "channel_id", e.snap.chID)
	}
}

// inherit is registerNow's grace step: a resuming socket (lastSeq > 0) inherits the
// membership its previous socket parked, so a blip keeps the call. The snap carries the
// join token and E2EE key, letting registerNow's subscribe restore the voice topic. Taking
// the entry stops its timer, and expireVoiceGrace's takeForExpiry, under the same member lock,
// finds it gone, so inheriting and teardown never both run. Returns the channel id or 0. Skipped when the
// old-client transfer already supplied a session. A fresh connect (lastSeq == 0) is a
// deliberate reload and discards any parked entry.
func (t *voiceTxn) inherit(c *Client) int64 {
	// Only the session that parked the call may take it back; another device's stays parked for itself.
	e := t.h.voiceHub.reg.voiceGrace.get(c.userID)
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
