package ws

import "time"

// beginTargetedFanout and endTargetedFanout bracket an unsequenced, targeted fan-out that walks a
// snapshot of connected users outside seqMu. While one is in flight mustFullResyncAtRegister forces
// every reconnect onto a full ready: the loop may have skipped it and its last_seq can exceed the
// leading watermark bump. Both take seqMu, which reconnectRegister holds across check-then-
// register, so a reconnect either registers before begin (and is in the snapshot), sees the
// counter, or checks after end against a watermark covering the fan-out. Never call either holding
// seqMu.
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

// broadcastChannelCreateRaceHook runs per audience member in BroadcastChannelCreate's fan-out;
// test-only, lands a reconnect's watermark re-check mid-fan-out (like
// refreshChannelVisibilityRaceHook).
var broadcastChannelCreateRaceHook func(userID int64)

func fireBroadcastChannelCreateRaceHook(userID int64) {
	if broadcastChannelCreateRaceHook != nil {
		broadcastChannelCreateRaceHook(userID)
	}
}
