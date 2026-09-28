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
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// voiceGraceWindow is RT-8's reconnect grace (see the file comment). 15 s
// covers a typical roam and stays well under the 60 s stale sweep, so the
// sweep's backstop still reaps a membership whose client never returns. A var
// so tests can shrink it (the staleClientTimeout / pingInterval pattern).
var voiceGraceWindow = 15 * time.Second

// voiceGraceEntry is one parked membership: the disconnected socket (for the
// teardown's log line and username), the membership it held, and the E2EE
// key that must survive with it (the client keeps its keypair across a blip
// and only re-announces on a LiveKit reconnect).
type voiceGraceEntry struct {
	client    *Client
	channelID int64
	joinToken string
	e2eeKey   string
	e2eeSig   string
	timer     *time.Timer
}

// voiceGraceState is the userID -> parked membership map. A second drop while
// the first is still parked replaces the entry (and stops its timer), so a
// user can never have two windows pending.
type voiceGraceState struct {
	mu      syncutil.Mutex
	entries map[int64]*voiceGraceEntry
}

// put parks e for userID and starts its expiry timer under the lock, so no
// reader ever sees the entry without its timer.
func (s *voiceGraceState) put(userID int64, e *voiceGraceEntry, expire func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.entries == nil {
		s.entries = map[int64]*voiceGraceEntry{}
	}
	if old := s.entries[userID]; old != nil {
		old.timer.Stop()
	}
	e.timer = time.AfterFunc(voiceGraceWindow, expire)
	s.entries[userID] = e
}

// get returns userID's parked entry, or nil. Its channelID and joinToken are
// immutable once parked, so the caller may read them without the lock.
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
	if e == nil || (channelID != 0 && e.channelID != channelID) || (joinToken != "" && e.joinToken != joinToken) {
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

// has reports whether userID has a parked membership for channelID.
func (s *voiceGraceState) has(userID, channelID int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[userID]
	return e != nil && e.channelID == channelID
}

// snapshot copies the parked (userID -> channelID) pairs so a caller can skip
// them without holding this lock while taking the hub lock.
func (s *voiceGraceState) snapshot() map[int64]int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[int64]int64, len(s.entries))
	for uid, e := range s.entries {
		out[uid] = e.channelID
	}
	return out
}

// leaveVoiceOnDisconnect is the socket-teardown voice step (readPump and a
// failed handshake). A completed
// membership is parked in the grace window; anything else (disabled window, a
// failed/half join, a kick that refuses reconnection) leaves immediately.
func (h *Hub) leaveVoiceOnDisconnect(ctx context.Context, c *Client, reason string) {
	key, sig := c.getE2EEPubKey()
	chID, joinToken, completed := c.clearVoiceState()
	if chID == 0 {
		return
	}
	h.pubsub.Unsubscribe(c, VoiceTopic(chID))
	if !completed || voiceGraceWindow <= 0 || c.isTerminallyKicked() {
		h.finishVoiceLeave(ctx, c, chID, joinToken, reason)
		return
	}
	entry := &voiceGraceEntry{
		client:    c,
		channelID: chID,
		joinToken: joinToken,
		e2eeKey:   key,
		e2eeSig:   sig,
	}
	h.voiceGrace.put(c.userID, entry, func() { //nolint:contextcheck // the timer outlives the disconnect ctx; expiry uses its own.
		h.expireVoiceGrace(c.userID, entry)
	})
	slog.Info("voice leave deferred (grace window)",
		"user_id", c.userID, "channel_id", chID,
		"grace_ms", voiceGraceWindow.Milliseconds())
}

// expireVoiceGrace tears down a parked membership whose window elapsed. It
// removes the entry before the teardown so the slow finishVoiceLeave never
// runs with this lock held and a superseding reconnect cannot race it.
func (h *Hub) expireVoiceGrace(userID int64, entry *voiceGraceEntry) {
	if !h.voiceGrace.takeIfSame(userID, entry) {
		return
	}
	h.leaveParkedVoice(context.Background(), entry, voiceLeaveReasonGraceExpired)
}

// leaveParkedVoice runs the full voice teardown for a parked membership
// already taken from the grace window, reporting false for a nil entry.
func (h *Hub) leaveParkedVoice(ctx context.Context, e *voiceGraceEntry, reason string) bool {
	if e == nil {
		return false
	}
	h.finishVoiceLeave(ctx, e.client, e.channelID, e.joinToken, reason)
	return true
}

// dropOrphanVoiceGrace drops userID's parked membership when its exact
// voice_states row (channel and joined_at) is gone, so a resume never
// inherits a membership with no row. A failed read keeps the entry.
func (h *Hub) dropOrphanVoiceGrace(ctx context.Context, userID int64) {
	e := h.voiceGrace.get(userID)
	if e == nil {
		return
	}
	row, err := h.voice.State(ctx, userID)
	if err != nil || (row != nil && row.ChannelID == e.channelID && row.JoinedAt == e.joinToken) {
		return
	}
	if h.voiceGrace.takeIfSame(userID, e) {
		slog.Info("voice grace dropped: its voice state row is gone",
			"user_id", userID, "channel_id", e.channelID)
	}
}

// inheritParkedVoice is registerNow's RT-8 step: a resuming socket
// (lastSeq > 0) inherits the voice membership its previous socket parked in
// the grace window when it dropped, so a short network blip keeps the call
// instead of ending it. The parked entry carries the completed join's token
// and E2EE key; re-stamping them lets registerNow's subscribe block restore
// the voice topic exactly as the still-registered-old-client transfer does.
// `take` stops the expiry timer, so inheriting and tearing down can never
// both run. It returns the inherited channel id, or 0.
//
// Skipped when the old-client transfer already supplied a session
// (c.getVoiceChID() != 0) — a reconnect that beat the drop teardown. A fresh
// connect (lastSeq == 0) is a deliberate reload rather than a blip, so it
// discards any parked entry instead.
func (h *Hub) inheritParkedVoice(c *Client) int64 {
	if c.lastSeq == 0 {
		h.voiceGrace.take(c.userID)
		return 0
	}
	if c.getVoiceChID() != 0 {
		return 0
	}
	e := h.voiceGrace.take(c.userID)
	if e == nil {
		return 0
	}
	c.setVoiceState(e.channelID, e.joinToken)
	c.markVoiceJoinCompleteIfMatch(e.channelID, e.joinToken)
	c.setE2EEPubKey(e.e2eeKey, e.e2eeSig)
	slog.Info("hub: resumed connection inherited the grace-window voice membership",
		"user_id", c.userID, "channel_id", e.channelID)
	return e.channelID
}
