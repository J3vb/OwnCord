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

func (s *voiceGraceState) put(userID int64, e *voiceGraceEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.entries == nil {
		s.entries = map[int64]*voiceGraceEntry{}
	}
	if old := s.entries[userID]; old != nil && old.timer != nil {
		old.timer.Stop()
	}
	s.entries[userID] = e
}

// take removes and returns the parked entry for userID, or nil. It stops the
// entry's timer, so a resuming socket that inherits the membership does not
// also get the expiry teardown.
func (s *voiceGraceState) take(userID int64) *voiceGraceEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[userID]
	delete(s.entries, userID)
	if e != nil && e.timer != nil {
		e.timer.Stop()
	}
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
	return true
}

// cancel stops and drops any parked entry for userID.
func (s *voiceGraceState) cancel(userID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e := s.entries[userID]; e != nil {
		if e.timer != nil {
			e.timer.Stop()
		}
		delete(s.entries, userID)
	}
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

// leaveVoiceOnDisconnect is the readPump-teardown voice step. A completed
// membership is parked in the grace window; anything else (disabled window, a
// failed/half join) leaves immediately.
func (h *Hub) leaveVoiceOnDisconnect(ctx context.Context, c *Client, chID int64, joinToken string, completed bool) {
	if !completed || voiceGraceWindow <= 0 {
		h.handleVoiceLeave(ctx, c, voiceLeaveReasonDisconnect)
		return
	}
	key, sig := c.getE2EEPubKey()
	h.clearVoiceAndUnsubscribe(c)
	entry := &voiceGraceEntry{
		client:    c,
		channelID: chID,
		joinToken: joinToken,
		e2eeKey:   key,
		e2eeSig:   sig,
	}
	h.voiceGrace.put(c.userID, entry)
	entry.timer = time.AfterFunc(voiceGraceWindow, func() {
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
	h.finishVoiceLeave(context.Background(), entry.client, entry.channelID, entry.joinToken, voiceLeaveReasonGraceExpired)
}

// expireVoiceGraceNowForTest force-expires a parked window so a test does not
// wait the real 15 s. Test-only.
func (h *Hub) expireVoiceGraceNowForTest(userID int64) {
	e := h.voiceGrace.take(userID)
	if e == nil {
		return
	}
	if e.timer != nil {
		e.timer.Stop()
	}
	h.finishVoiceLeave(context.Background(), e.client, e.channelID, e.joinToken, voiceLeaveReasonGraceExpired)
}

// voiceGraceInheritedForTest reports whether userID holds a parked entry for
// channelID. Test-only.
func (h *Hub) voiceGraceInheritedForTest(userID, channelID int64) bool {
	for uid, ch := range h.voiceGrace.snapshot() {
		if uid == userID && ch == channelID {
			return true
		}
	}
	return false
}
