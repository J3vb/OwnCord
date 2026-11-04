package ws

import "context"

// leaveVoiceLocked runs a client-requested voice leave under c's voice lock.
func (h *Hub) leaveVoiceLocked(c *Client, reason string) {
	txn := h.begin(c.userID)
	defer txn.end()
	h.handleVoiceLeave(c.ctx, txn, c, reason)
}

// leaveParkedVoiceLocked tears down userID's parked membership, if any, under
// the voice lock. Taking the lock first means a teardown that is parking the
// membership right now finishes before the take looks for it.
func (h *Hub) leaveParkedVoiceLocked(userID int64, reason string) {
	txn := h.begin(userID)
	defer txn.end()
	h.leaveParkedVoice(context.Background(), txn, txn.takeParked(0), reason)
}

// voiceJoinPostCommitRaceHook, when non-nil, runs in voiceJoinPersist after
// the voice_states row is committed and read back, immediately before
// c.setVoiceState. sweepStaleVoicePreDeleteRaceHook, when non-nil, runs in
// sweepStaleVoiceStates after the live-client recheck, immediately before
// LeaveIfMatch. Test-only (always nil in production): together they hold a
// join and the sweep inside the window the voice lock closes.
var (
	voiceJoinPostCommitRaceHook      func(*Client)
	sweepStaleVoicePreDeleteRaceHook func(userID, channelID int64, joinedAt string)
)
