package ws

import "time"

// A moderator move of a member whose call is parked in the grace window cannot reach the
// member's device (its socket is gone). The eviction still runs at once and the move is
// kept for the parking session as a parkedModMove. When that session resumes inside the
// window, registerNow collects it: the mute/deafen goes onto the new connection's stash,
// the frames the move sent (voice_moved) are delivered, and the connection is stamped as
// the moderator frame's target, so a later SendToVoiceDevice reaches it. Collecting does
// not end the move: a resume whose handshake then fails takes the frames and stash down
// with its connection, so the next resume collects them again. The move ends with the
// user's next voice_join on any device (takeUserModFlags), which also carries its flags, so
// a join on another device is never pulled away by a later resume.

const parkedModMoveCap = 4

type parkedModMove struct {
	tokenHash string
	flags     modFlagStash
	frames    [][]byte
	at        time.Time
	// collected is set once a resume took the move: later frames still go to the stamped connection and are
	// kept for a resume after a failed one.
	collected bool
}

// fresh reports whether the parked session can still resume; past the grace window the call would have ended,
// so the move is dropped.
func (m *parkedModMove) fresh(now time.Time) bool {
	return now.Sub(m.at) <= voiceGraceWindow
}

// noteParkedModMove records a moderator move that evicted tokenHash's parked call,
// replacing any earlier one. The caller holds the user's membership lock.
func (s *voiceGraceState) noteParkedModMove(userID int64, tokenHash string, flags modFlagStash) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	if s.modMoves == nil {
		s.modMoves = map[int64]*parkedModMove{}
	}
	s.modMoves[userID] = &parkedModMove{tokenHash: tokenHash, flags: flags, at: time.Now()}
}

func (s *voiceGraceState) dropParkedModMove(userID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.modMoves, userID)
}

// queueParkedModMoveFrame keeps msg for the parked session of userID's pending move and
// reports whether that is its only delivery. False when there is no fresh move, its frame
// bound is reached, or a resume already collected it (the caller sends to the stamped
// connection; msg is still kept for a resume after a failed one).
func (s *voiceGraceState) queueParkedModMoveFrame(userID int64, msg []byte) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.modMoves[userID]
	if m == nil {
		return false
	}
	if !m.fresh(time.Now()) {
		delete(s.modMoves, userID)
		return false
	}
	if len(m.frames) >= parkedModMoveCap {
		return false
	}
	m.frames = append(m.frames, msg)
	return !m.collected
}

// endParkedModMove ends userID's pending move for a voice_join and returns its flags (zero if none). The
// caller holds the membership lock.
func (s *voiceGraceState) endParkedModMove(userID int64) modFlagStash {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.modMoves[userID]
	delete(s.modMoves, userID)
	if m == nil || !m.fresh(time.Now()) {
		return modFlagStash{}
	}
	return m.flags
}

// takeParkedModMove hands c a copy of the pending move its session's parked call was
// evicted by, or nil. Only the parking session collects it; a fresh connect of that session
// (a reload) drops it. c is stamped as the moderator's target under the lock
// queueParkedModMoveFrame takes, so a frame sent meanwhile is kept for c or finds c by its stamp.
func (s *voiceGraceState) takeParkedModMove(c *Client) *parkedModMove {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.modMoves[c.userID]
	if m == nil || m.tokenHash != c.tokenHash {
		return nil
	}
	if c.lastSeq == 0 || !m.fresh(time.Now()) {
		delete(s.modMoves, c.userID)
		return nil
	}
	m.collected = true
	c.voiceExitAt.Store(m.at.UnixNano())
	return &parkedModMove{flags: m.flags, frames: append([][]byte(nil), m.frames...)}
}

// collectParkedModMove is registerNow's step for a resume whose parked call a moderator moved: stashes the
// flags on c for its re-join and delivers the move's frames. The caller holds c's membership lock.
func (h *Hub) collectParkedModMove(c *Client) {
	m := h.voiceHub.reg.voiceGrace.takeParkedModMove(c)
	if m == nil {
		return
	}
	if m.flags.muted || m.flags.deafened {
		c.voice.stashModFlags(m.flags.muted, m.flags.deafened, m.flags.mutedBy)
	}
	for _, f := range m.frames {
		c.sendMsg(f)
	}
}
