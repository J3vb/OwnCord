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

func (h *Hub) nextSeq() uint64 {
	return atomic.AddUint64(&h.seq, 1)
}

func (h *Hub) ReplayBuffer() *EventRingBuffer {
	return h.replayBuf
}

func (h *Hub) CurrentSeq() uint64 { return atomic.LoadUint64(&h.seq) }

// SeedSeq sets the hub's monotonic sequence counter to seed (atomic), at startup, to
// align in-memory seqs with the persisted MAX(events.seq) so wrapped-payload seqs
// stay monotonic across restarts. A seed below the current seq is a no-op.
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

// SetEventPersister attaches a persister so broadcasts are also written to the
// EventStore; nil disables. Safe at any time, including after Run has started.
func (h *Hub) SetEventPersister(p *EventPersister) {
	h.eventPersister.Store(p)
}

// SetEventStore attaches the read-side EventStore for cold-tier reconnect replay,
// typically the one behind SetEventPersister; nil disables. Safe at any time.
func (h *Hub) SetEventStore(s EventStore) {
	if s == nil {
		h.eventStore.Store(nil)
		return
	}
	var guarded EventStore = purgeGuardedStore{EventStore: s, purge: &h.tombstones}
	h.eventStore.Store(&guarded)
}

// SetPluginEventSink wires the plugin.EventSink so the hub fans out each sequenced
// broadcast to plugins; nil disables. Safe at any time. Deliberately still a setter:
// the sink consumes the built hub's broadcaster (sink.SetBroadcaster), so it cannot
// exist before the hub, unlike the registry (a HubOptions field).
func (h *Hub) SetPluginEventSink(s *plugin.EventSink) {
	h.pluginSink.Store(s)
}

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

var pluginDispatchHook atomic.Pointer[func(h *Hub, msg []byte)]

// ReconnectTierStats returns the per-tier resume hit counters (buffer, db, full);
// the OpenTelemetry meters read the same atomics.
func (h *Hub) ReconnectTierStats() (buffer, db, full uint64) {
	return h.reconnectTierBuf.Load(), h.reconnectTierDB.Load(), h.reconnectTierFull.Load()
}

// noteRingMiss counts a resume the ring just failed to serve, only when the client is
// behind the ring's oldest entry: the ring also returns nil for an empty ring and
// for a client ahead of it, and the events table serves neither. One atomic, no
// hub lock, no I/O, so it is safe outside seqMu on the handshake path. Re-reading
// the ring can race a push, which is harmless.
func (h *Hub) noteRingMiss(lastSeq uint64) {
	if oldest := h.ReplayBuffer().OldestSeq(); oldest != 0 && lastSeq <= oldest {
		h.reconnectRingMiss.Add(1)
	}
}

// ReconnectRingMissCount returns the lifetime resumes that passed the resync checks
// but fell behind the in-memory ring; the events table hit rate is
// ReconnectTierStats' db divided by this. A separate method so ReconnectTierStats
// keeps its admin-interface signature.
func (h *Hub) ReconnectRingMissCount() uint64 {
	return h.reconnectRingMiss.Load()
}

// mustFullResync reports whether a client resuming from lastSeq predates the latest
// channel-visibility change or content shed and cannot converge via replay.
func (h *Hub) mustFullResync(lastSeq uint64) bool {
	if w := h.visibilityChangeSeq.Load(); w > 0 && lastSeq <= w {
		return true
	}
	// An erasure's replay purge cleared slots up to this watermark (the seq of the last
	// frame sequenced before it, the member_ban included), so a client that has not
	// acked that far may have missed the ban and cannot be served the range around it.
	w := h.replayPurgeSeq.Load()
	return w > 0 && lastSeq < w
}

// bumpReplayPurgeWatermark ratchets replayPurgeSeq up to the current seq, never
// down (bumpVisibilityWatermark's CAS-max pattern).
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

// replayPurgeBeforeDelete, when set by a test, runs after a purge's in-memory step
// released seqMu and before the persisted rows are deleted.
var replayPurgeBeforeDelete func()

// PurgeMessagesFromReplay takes every frame about the given messages out of the
// replay pipeline after a retention sweep removed them: the dispatch loop is
// drained so a frame queued before the sweep is sequenced, then purgeReplay
// installs the ids as tombstones and drops the ring's copies under seqMu, and
// deletes the persisted rows after releasing it. A client resuming across the holes
// falls through the ring's gap rule and the cold tier's row count to the full
// ready, which no longer holds the messages. Idempotent; the sweep journals the ids
// until this succeeds.
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

// PurgeUserFromReplay takes every frame naming userID out of the replay pipeline
// after an account erasure: the dispatch loop is drained so the erasure's
// member_ban is sequenced, then purgeReplay, under seqMu, adds the user to the
// tombstones, moves the replay-purge watermark to the current seq (a client resuming
// from before it takes the full ready) and drops the ring's copies, then deletes the
// persisted rows after releasing it. Idempotent; retried from the erasure journal.
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

// purgeReplay runs a replay purge in the order that keeps seqMu short: drain the
// dispatch loop; take the purge lock, which keeps cold-tier reads out until the
// rows are gone; under seqMu install the tombstones and drop the ring's copies, so
// no frame naming them is sequenced from here on; release seqMu; flush the
// persister so every frame sequenced before the tombstones is on disk; delete the
// persisted rows.
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

// purgePersisted flushes the persister so every frame sequenced before the
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

// awaitDispatch returns once every broadcast enqueued on h.broadcast before the call
// has been sequenced, buffered and handed to the persister, including content parked
// on its gate (hub_content_gate.go). BroadcastToAll is asynchronous, so a caller that
// broadcast a member_ban and now purges replay behind it needs this barrier first. A
// hub whose dispatch loop is not running (a test hub, a hub after GracefulStop) has
// nothing queued to wait for.
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

// eventNamesUser reports whether a wrapped broadcast frame names userID (frameRefs
// lists where); an unparseable frame names nobody.
func eventNamesUser(data []byte, userID int64) bool {
	refs, ok := parseFrameRefs(data)
	if !ok {
		return false
	}
	_, hit := userIn(&refs, map[int64]struct{}{userID: {}})
	return hit
}

// messageFamily lists the frame types that carry a message's content or name one:
// what a retention purge removes and a tombstone drops.
var messageFamily = map[string]struct{}{
	MsgTypeChatMessage:     {},
	MsgTypeChatEdited:      {},
	MsgTypeChatDeleted:     {},
	MsgTypeChatBulkDeleted: {},
	MsgTypeReactionUpdate:  {},
	MsgTypePollUpdate:      {},
}

// eventNamesMessage reports whether a wrapped frame is a message-family frame about
// one of ids; an unparseable frame is about nothing.
func eventNamesMessage(data []byte, ids map[int64]struct{}) bool {
	refs, ok := parseFrameRefs(data)
	return ok && messageIn(&refs, ids)
}

// persistEvent enqueues a broadcast event for cold-storage persistence; safe with a
// nil persister and never blocks the hot path. seq is the hub-assigned counter
// embedded in payload, so the stored row-seq matches the payload-seq the client tracks.
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

// extractEventType scans a wrapped JSON envelope for the "type" field value, or ""
// on any parse failure so the caller can substitute a generic label. Intentionally
// not a full JSON decode: it looks for the literal `"type":"<value>"` token, which
// matches every envelope this server produces, avoiding encoding/json allocation on
// the broadcast hot path.
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
	// Reject values with control chars or escapes (a clean label, not arbitrary
	// user-controlled metadata); length-capped defensively.
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

// sequenceable reports whether wrapWithSeq stamps msg: a non-empty JSON object no
// larger than config.MaxMessageBytes; anything else passes through.
func sequenceable(msg []byte) bool {
	return len(msg) >= 2 && len(msg) <= config.MaxMessageBytes && msg[0] == '{'
}

// wrapWithSeq injects a "seq" field into a JSON message without re-serializing.
func wrapWithSeq(msg []byte, seq uint64) []byte {
	// Fast path: inject seq after the opening brace, e.g. {"type":...} becomes
	// {"seq":123,"type":...}. Frames above config.MaxMessageBytes pass through
	// unsequenced like a non-object frame; every server-built envelope is far smaller,
	// and the bound keeps the capacity arithmetic below overflow-free.
	if !sequenceable(msg) {
		return msg
	}
	// `{"seq":` + up to 20 digits + `,` is at most 28 extra bytes; the single make is the
	// only allocation on this hot path.
	result := make([]byte, 0, len(msg)+28)
	result = append(result, `{"seq":`...)
	result = strconv.AppendUint(result, seq, 10)
	result = append(result, ',')
	result = append(result, msg[1:]...) // skip opening brace
	return result
}
