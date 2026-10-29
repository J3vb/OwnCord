package ws

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/plugin"
)

// nextSeq returns the next monotonic sequence number for broadcast messages.
func (h *Hub) nextSeq() uint64 {
	return atomic.AddUint64(&h.seq, 1)
}

// ReplayBuffer returns the hub's event ring buffer for reconnection replay.
func (h *Hub) ReplayBuffer() *EventRingBuffer {
	return h.replayBuf
}

// CurrentSeq returns the hub's monotonic sequence counter (atomic).
func (h *Hub) CurrentSeq() uint64 { return atomic.LoadUint64(&h.seq) }

// SeedSeq sets the hub's monotonic sequence counter to seed (atomic). Used
// at startup to align in-memory seqs with the persisted MAX(events.seq) so
// wrapped-payload seqs stay monotonic across restarts. Calling SeedSeq with
// a value less than the current seq is a no-op (we never go backwards).
func (h *Hub) SeedSeq(seed uint64) {
	for {
		cur := atomic.LoadUint64(&h.seq)
		if seed <= cur {
			return
		}
		if atomic.CompareAndSwapUint64(&h.seq, cur, seed) {
			return
		}
	}
}

// SetEventPersister attaches a persister so subsequent broadcasts are also
// written to the persistent EventStore. Pass nil to disable. Safe to call
// at any time, including after Run has started.
func (h *Hub) SetEventPersister(p *EventPersister) {
	h.eventPersister.Store(p)
}

// SetEventStore attaches a read-side EventStore used by the cold-tier
// reconnect replay path. Typically the same store backing SetEventPersister.
// Pass nil to disable. Safe to call at any time, including after Run has
// started.
func (h *Hub) SetEventStore(s EventStore) {
	if s == nil {
		h.eventStore.Store(nil)
		return
	}
	var guarded EventStore = purgeGuardedStore{EventStore: s, purge: &h.tombstones}
	h.eventStore.Store(&guarded)
}

// SetPluginEventSink wires the plugin.EventSink so the hub fans out each
// sequenced broadcast to subscribed plugins. Pass nil to disable. Safe to
// call at any time, including after Run has started.
//
// Deliberately still a setter: the sink consumes the built hub's
// broadcaster (sink.SetBroadcaster(hub.BroadcastToChannel)), so it cannot
// exist before the hub does — a genuine two-phase wire, unlike the registry,
// which is a HubOptions field.
func (h *Hub) SetPluginEventSink(s *plugin.EventSink) {
	h.pluginSink.Store(s)
}

// dispatchToPlugins hands one sequenced frame to the plugin sink, if any.
func (h *Hub) dispatchToPlugins(msg []byte) {
	sink := h.pluginSink.Load()
	if sink == nil {
		return
	}
	eventType := extractEventType(msg)
	if eventType == "" {
		eventType = "broadcast"
	}
	if hook := pluginDispatchHook.Load(); hook != nil {
		(*hook)(h, msg)
	}
	sink.Dispatch(context.Background(), eventType, msg)
}

// pluginDispatchHook is a test seam called right before the plugin sink.
var pluginDispatchHook atomic.Pointer[func(h *Hub, msg []byte)]

// ReconnectTierStats returns the per-tier resume hit counters in the order
// (buffer, db, full). Phase B Step 7 metrics surface; OpenTelemetry meters
// (Step 8) read from the same atomics.
func (h *Hub) ReconnectTierStats() (buffer, db, full uint64) {
	return h.reconnectTierBuf.Load(), h.reconnectTierDB.Load(), h.reconnectTierFull.Load()
}

// noteRingMiss counts a resume the ring just failed to serve, but only when the
// client is behind the ring's oldest entry: the ring also returns nil for an
// empty ring and for a client ahead of it, and the events table serves neither.
// One atomic, no hub lock, no I/O, so it is safe outside seqMu on the handshake path.
// The re-read of the ring can race a push, which is harmless here.
func (h *Hub) noteRingMiss(lastSeq uint64) {
	if oldest := h.ReplayBuffer().OldestSeq(); oldest != 0 && lastSeq <= oldest {
		h.reconnectRingMiss.Add(1)
	}
}

// ReconnectRingMissCount returns the lifetime number of resumes that passed the
// resync checks but fell behind the in-memory replay ring. The hit
// rate of the events table is ReconnectTierStats' db / this. It is a separate
// method so ReconnectTierStats keeps its admin-interface signature.
func (h *Hub) ReconnectRingMissCount() uint64 {
	return h.reconnectRingMiss.Load()
}

// mustFullResync reports whether a client resuming from lastSeq predates the
// most recent channel-visibility change or content shed and
// therefore cannot converge via replay.
func (h *Hub) mustFullResync(lastSeq uint64) bool {
	if w := h.visibilityChangeSeq.Load(); w > 0 && lastSeq <= w {
		return true
	}
	// An erasure's replay purge cleared slots up to this watermark — the
	// seq of the last frame sequenced before it, the member_ban included —
	// so a client that has not acked that far may have missed the ban and
	// cannot be served the range around it; one that has, saw everything.
	w := h.replayPurgeSeq.Load()
	return w > 0 && lastSeq < w
}

// bumpReplayPurgeWatermark ratchets replayPurgeSeq up to the current seq,
// never down (bumpVisibilityWatermark's CAS-max pattern).
func (h *Hub) bumpReplayPurgeWatermark() {
	for {
		cur := h.replayPurgeSeq.Load()
		next := atomic.LoadUint64(&h.seq)
		if next <= cur {
			return
		}
		if h.replayPurgeSeq.CompareAndSwap(cur, next) {
			return
		}
	}
}

// replayPurgeBeforeDelete, when set by a test, runs after a purge's
// in-memory step has released seqMu and before the persisted rows are
// deleted.
var replayPurgeBeforeDelete func()

// PurgeMessagesFromReplay takes every frame about the given messages out of
// the replay pipeline after a retention sweep removed them: the
// dispatch loop is drained so a frame queued before the sweep is sequenced,
// then purgeReplay installs the ids as tombstones and drops the ring's
// copies under seqMu, and deletes the persisted rows after releasing it. A
// client resuming across the holes this leaves falls through the ring's gap
// rule and the cold tier's row count to the full ready, which no longer
// holds the messages. Idempotent; the sweep journals the ids until this
// succeeds.
func (h *Hub) PurgeMessagesFromReplay(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	h.activity.forget(nil, ids)
	set := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	dropped, rows, err := h.purgeReplay(ctx, &h.tombstones.unfinishedMessages, ids,
		func(seq uint64) { h.tombstones.add(&h.tombstones.messages, seq, ids...) },
		func(data []byte) bool { return eventNamesMessage(data, set) },
		func(ctx context.Context) (int64, error) { return h.db.DeleteEventsForMessages(ctx, ids) })
	if err != nil {
		return err
	}
	slog.Info("hub: replay purged for swept messages", "messages", len(ids), "buffered", dropped, "persisted", rows)
	return nil
}

// PurgeUserFromReplay takes every frame naming userID out of the replay
// pipeline after an account erasure:
// the dispatch loop is drained so the member_ban the erasure broadcast is
// sequenced, then purgeReplay, under seqMu, adds the user to the tombstones,
// moves the replay-purge watermark to the current seq (a client resuming
// from before it takes the full ready) and drops the ring's copies, and
// deletes the persisted rows after releasing it. Idempotent and retried
// from the erasure journal on failure.
func (h *Hub) PurgeUserFromReplay(ctx context.Context, userID int64) error {
	h.activity.forget([]int64{userID}, nil)
	dropped, rows, err := h.purgeReplay(ctx, &h.tombstones.unfinishedUsers, []int64{userID},
		func(seq uint64) {
			h.tombstones.add(&h.tombstones.users, seq, userID)
			h.bumpReplayPurgeWatermark()
		},
		func(data []byte) bool { return eventNamesUser(data, userID) },
		func(ctx context.Context) (int64, error) { return h.db.DeleteEventsForUser(ctx, userID) })
	if err != nil {
		return err
	}
	slog.Info("hub: replay purged for erased user", "user_id", userID, "buffered", dropped, "persisted", rows)
	return nil
}

// purgeReplay runs a replay purge in the order that keeps seqMu short:
// drain the dispatch loop; take the purge lock, which keeps
// cold-tier reads out until the rows are gone; under seqMu, install the
// tombstones and drop the ring's copies, so from here on no frame naming
// them is sequenced; release seqMu; flush the persister, so every frame
// sequenced before the tombstones is on disk; delete the persisted rows.
func (h *Hub) purgeReplay(
	ctx context.Context, unfinished *map[int64]struct{}, ids []int64,
	install func(seq uint64), names func([]byte) bool, deleteRows func(context.Context) (int64, error),
) (dropped int, rows int64, err error) {
	if err := h.awaitDispatch(ctx); err != nil {
		return 0, 0, fmt.Errorf("purge replay: %w", err)
	}
	if err := h.tombstones.lock(ctx); err != nil {
		return 0, 0, err
	}
	defer h.tombstones.mu.Unlock()

	func() {
		h.seqMu.Lock()
		start := time.Now()
		defer h.seqMu.Unlock()
		defer h.observeSeqMuHold(start)
		install(atomic.LoadUint64(&h.seq))
		dropped = h.replayBuf.RemoveWhere(names)
	}()

	rows, err = h.purgePersisted(ctx, deleteRows)
	settlePurge(unfinished, ids, err == nil)
	if err != nil {
		slog.Warn("hub: replay purge unfinished; cold-tier replay is off until it is retried", "err", err)
		return dropped, 0, err
	}
	return dropped, rows, nil
}

// purgePersisted flushes the persister, so every frame sequenced before the
// tombstones is on disk, then deletes the persisted rows.
func (h *Hub) purgePersisted(ctx context.Context, deleteRows func(context.Context) (int64, error)) (rows int64, err error) {
	if p := h.eventPersister.Load(); p != nil {
		if err := p.Flush(ctx); err != nil {
			return 0, fmt.Errorf("purge replay: flush: %w", err)
		}
	}
	if replayPurgeBeforeDelete != nil {
		replayPurgeBeforeDelete()
	}
	if h.db == nil {
		return 0, nil
	}
	if rows, err = deleteRows(ctx); err != nil {
		return 0, fmt.Errorf("purge replay: %w", err)
	}
	return rows, nil
}

// awaitDispatch returns once every broadcast enqueued on h.broadcast before
// the call has been sequenced, buffered and handed to the persister,
// including content that parked on its gate (hub_content_gate.go). BroadcastToAll is asynchronous, so the caller
// that just broadcast a member_ban and now wants to purge replay behind it
// needs this barrier first. A hub whose dispatch loop is not running (a
// test hub, a hub after GracefulStop) has nothing queued to wait for.
func (h *Hub) awaitDispatch(ctx context.Context) error {
	if !h.running.Load() || !h.DispatchAlive() {
		return nil
	}
	done := make(chan struct{})
	select {
	case h.broadcast <- broadcastMsg{barrier: done}:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// eventNamesUser reports whether a wrapped broadcast frame names userID
// (frameRefs lists where). An unparseable frame names nobody.
func eventNamesUser(data []byte, userID int64) bool {
	refs, ok := parseFrameRefs(data)
	if !ok {
		return false
	}
	_, hit := userIn(&refs, map[int64]struct{}{userID: {}})
	return hit
}

// messageFamily lists the frame types that carry a message's content or
// name one: what a retention purge removes and a tombstone drops.
var messageFamily = map[string]struct{}{
	MsgTypeChatMessage:     {},
	MsgTypeChatEdited:      {},
	MsgTypeChatDeleted:     {},
	MsgTypeChatBulkDeleted: {},
	MsgTypeReactionUpdate:  {},
	MsgTypePollUpdate:      {},
}

// eventNamesMessage reports whether a wrapped broadcast frame is a
// message-family frame about one of ids (frameRefs lists where). An
// unparseable frame is about nothing.
func eventNamesMessage(data []byte, ids map[int64]struct{}) bool {
	refs, ok := parseFrameRefs(data)
	return ok && messageIn(&refs, ids)
}

// persistEvent enqueues a broadcast event for cold-storage persistence. Safe
// to call with a nil persister; never blocks the broadcast hot path. seq is
// the same hub-assigned monotonic counter embedded in payload, so the row
// written to the EventStore has a row-seq that matches the wrapped-payload
// seq the client tracks.
func (h *Hub) persistEvent(seq uint64, channelID int64, payload []byte) {
	p := h.eventPersister.Load()
	if p == nil {
		return
	}
	eventType := extractEventType(payload)
	if eventType == "" {
		eventType = "broadcast"
		if channelID != 0 {
			eventType = "channel_broadcast"
		}
	}
	p.Enqueue(int64(seq), eventType, channelID, payload) //nolint:gosec // seq is a monotonically increasing counter, never reaches MaxInt64
}

// extractEventType scans a wrapped JSON envelope for the value of the "type"
// field and returns it. Returns "" on any parse failure so the caller can
// substitute a generic label. The scan is intentionally not a full JSON
// decode — it only looks for the literal `"type":"<value>"` token, which
// matches every wire-format envelope produced by this server. This avoids the
// allocation cost of `encoding/json` on the broadcast hot path.
func extractEventType(payload []byte) string {
	const needle = `"type":"`
	idx := bytes.Index(payload, []byte(needle))
	if idx < 0 {
		return ""
	}
	start := idx + len(needle)
	end := bytes.IndexByte(payload[start:], '"')
	if end < 0 {
		return ""
	}
	t := payload[start : start+end]
	// Reject any value with control chars or escapes — we want a clean
	// label, not arbitrary user-controlled metadata. Length-cap defensively.
	if len(t) == 0 || len(t) > 64 {
		return ""
	}
	for _, b := range t {
		if b < 0x20 || b == '\\' {
			return ""
		}
	}
	return string(t)
}

// sequenceable reports whether wrapWithSeq stamps msg: a non-empty JSON object
// no larger than config.MaxMessageBytes. Anything else passes through as is.
func sequenceable(msg []byte) bool {
	return len(msg) >= 2 && len(msg) <= config.MaxMessageBytes && msg[0] == '{'
}

// wrapWithSeq injects a "seq" field into a JSON message without re-serializing.
func wrapWithSeq(msg []byte, seq uint64) []byte {
	// Fast path: inject seq after the opening brace.
	// e.g., {"type":"chat_message",...} → {"seq":123,"type":"chat_message",...}
	// Guard: msg must be a non-empty JSON object (starts with '{' and has content).
	// Frames above config.MaxMessageBytes pass through unsequenced, like a
	// non-object frame: every server-built envelope is far smaller, and the
	// bound keeps the capacity arithmetic below provably overflow-free.
	if !sequenceable(msg) {
		return msg
	}
	// `{"seq":` + up-to-20-digit uint64 + `,` = at most 28 extra bytes; the
	// single make below is the only allocation on this hot path (the previous
	// fmt.Sprintf built an intermediate string first).
	result := make([]byte, 0, len(msg)+28)
	result = append(result, `{"seq":`...)
	result = strconv.AppendUint(result, seq, 10)
	result = append(result, ',')
	result = append(result, msg[1:]...) // skip opening brace
	return result
}
