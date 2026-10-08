package ws

import "time"

// beginTargetedFanout and endTargetedFanout bracket an unsequenced, targeted
// fan-out that walks a snapshot of connected users outside seqMu. While one is
// in flight mustFullResyncAtRegister forces every reconnect onto a full ready:
// the reconnect may have been skipped by the loop, and its last_seq can be
// above the leading watermark bump (codex-oc-1732). Both take seqMu, the lock
// reconnectRegister holds across its check-then-register, so a reconnect
// either registers before begin (and is in the snapshot), sees the counter, or
// checks after end against a watermark covering every seq allocated during the
// fan-out. Do not call either while holding seqMu.
func (h *Hub) beginTargetedFanout() {
	h.seqMu.Lock()
	start := time.Now()
	defer h.seqMu.Unlock()
	defer h.observeSeqMuHold(start)
	h.targetedFanouts++
	h.bumpVisibilityWatermark()
}

func (h *Hub) endTargetedFanout() {
	h.seqMu.Lock()
	start := time.Now()
	defer h.seqMu.Unlock()
	defer h.observeSeqMuHold(start)
	h.bumpVisibilityWatermark()
	h.targetedFanouts--
}

// broadcastChannelCreateRaceHook, when non-nil, runs once per audience member
// inside BroadcastChannelCreate's fan-out loop. Test-only (always nil in
// production): it lands a reconnect's watermark re-check mid-fan-out
// deterministically, same pattern as refreshChannelVisibilityRaceHook.
var broadcastChannelCreateRaceHook func(userID int64)

func fireBroadcastChannelCreateRaceHook(userID int64) {
	if broadcastChannelCreateRaceHook != nil {
		broadcastChannelCreateRaceHook(userID)
	}
}
