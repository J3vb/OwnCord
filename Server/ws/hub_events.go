package ws

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"slices"
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

// SeedSeq sets the monotonic sequence counter at startup to the persisted MAX(events.seq) so seqs
// stay monotonic across restarts; a lower seed is a no-op.
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

// SetEventPersister attaches a persister so broadcasts are also written to the EventStore; nil
// disables. Safe at any time.
func (h *Hub) SetEventPersister(p *EventPersister) {
	h.events.eventPersister.Store(p)
}

// SetEventStore attaches the EventStore for cold-tier reconnect replay; nil disables. Safe at any
// time.
func (h *Hub) SetEventStore(s EventStore) {
	if s == nil {
		h.events.eventStore.Store(nil)
		return
	}
	var guarded EventStore = purgeGuardedStore{EventStore: s, purge: &h.tombstones}
	h.events.eventStore.Store(&guarded)
}

// SetPluginEventSink wires the sink that fans each sequenced broadcast out to plugins; nil
// disables. A setter because the sink consumes the built hub's broadcaster, so it cannot exist
// before the hub.
func (h *Hub) SetPluginEventSink(s *plugin.EventSink) {
	h.events.pluginSink.Store(s)
}

func (h *Hub) dispatchToPlugins(msg []byte) {
	sink := h.events.pluginSink.Load()
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

// ReconnectTierStats returns the per-tier resume hit counters (buffer, db, full); the OTel meters
// read the same atomics.
func (h *Hub) ReconnectTierStats() (buffer, db, full uint64) {
	return h.stats.ReconnectTierBuf.Load(), h.stats.ReconnectTierDB.Load(), h.stats.ReconnectTierFull.Load()
}

// noteRingMiss counts a resume the ring failed to serve, only when the client is behind the ring's
// oldest entry (the ring also returns nil for an empty ring or a client ahead of it, which the
// events table does not serve). One atomic, no lock or I/O, so it is safe outside seqMu; re-reading
// the ring can race a push, harmlessly.
func (h *Hub) noteRingMiss(lastSeq uint64) {
	if oldest := h.ReplayBuffer().OldestSeq(); oldest != 0 && lastSeq <= oldest {
		h.stats.ReconnectRingMiss.Add(1)
	}
}

// ReconnectRingMissCount returns lifetime resumes that fell behind the ring; the events-table hit
// rate is ReconnectTierStats' db over this. Separate so ReconnectTierStats keeps its admin-
// interface signature.
func (h *Hub) ReconnectRingMissCount() uint64 {
	return h.stats.ReconnectRingMiss.Load()
}

// mustFullResync reports whether a client resuming from lastSeq predates the latest visibility
// change or content shed and cannot converge via replay.
func (h *Hub) mustFullResync(lastSeq uint64) bool {
	if w := h.visibilityChangeSeq.Load(); w > 0 && lastSeq <= w {
		return true
	}
	// An erasure's replay purge cleared slots up to this watermark (the last frame sequenced before
	// it, the member_ban included), so a client that has not acked that far may have missed the
	// ban.
	w := h.replayPurgeSeq.Load()
	return w > 0 && lastSeq < w
}

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

// replayPurgeBeforeDelete is a test hook run after a purge's in-memory step released seqMu and
// before rows are deleted.
var replayPurgeBeforeDelete func()

// PurgeMessagesFromReplay takes every frame about the given messages out of the replay pipeline
// after a retention sweep: drain the dispatch loop, then purgeReplay installs the ids as tombstones
// and drops the ring's copies under seqMu and deletes persisted rows after releasing it. A client
// resuming across the holes falls through to the full ready. Idempotent; the sweep journals the ids
// until this succeeds.
func (h *Hub) PurgeMessagesFromReplay(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	dropped, rows, err := h.purgeMessageIDs(ctx, &h.tombstones.unfinishedMessages, ids, ids)
	if err != nil {
		return err
	}
	slog.Info("hub: replay purged for swept messages", "messages", len(ids), "buffered", dropped, "persisted", rows)
	return nil
}

// purgeMessageIDs tombstones ids and takes every frame about them out of the ring and the
// table; key is what the unfinished marker records.
func (h *Hub) purgeMessageIDs(ctx context.Context, unfinished *map[int64]struct{}, key, ids []int64) (int, int64, error) {
	h.activity.forget(nil, ids)
	set := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	return h.purgeReplay(ctx, unfinished, key,
		func(seq uint64) { h.tombstones.add(&h.tombstones.messages, seq, ids...) },
		func(data []byte) bool { return eventNamesMessage(data, set) },
		func(ctx context.Context) (int64, error) { return h.db.DeleteEventsForMessages(ctx, ids) })
}

// PurgeErasedMessagesFromReplay takes the frames about messages an erasure deleted out of the
// replay pipeline. An edit frame names its message, not its author, so the ring is asked
// which of its messages no longer exist (one pass) and the persisted tier is swept for rows
// written since the job's lock whose message is gone (bounded by created_at). Nothing is
// kept in memory between the drain and this call, so it also runs after a restart.
// Idempotent; retried from the erasure journal.
func (h *Hub) PurgeErasedMessagesFromReplay(ctx context.Context, jobID int64) error {
	var orphans, swept []int64
	if h.db != nil {
		var err error
		if orphans, err = h.db.MissingMessageIDs(ctx, h.replayBuf.MessageIDs()); err != nil {
			return fmt.Errorf("purge replay: %w", err)
		}
	}
	set := make(map[int64]struct{}, len(orphans))
	for _, id := range orphans {
		set[id] = struct{}{}
	}
	h.activity.forget(nil, orphans)
	dropped, rows, err := h.purgeReplay(ctx, &h.tombstones.unfinishedErasures, []int64{jobID},
		func(seq uint64) {
			if len(orphans) > 0 {
				h.tombstones.add(&h.tombstones.messages, seq, orphans...)
			}
		},
		func(data []byte) bool { return eventNamesMessage(data, set) },
		func(ctx context.Context) (int64, error) {
			var err error
			swept, err = h.db.DeleteOrphanMessageEvents(ctx, jobID)
			return int64(len(swept)), err
		})
	if err != nil {
		return err
	}
	// A frame the ring read missed but the sweep found: its ring copy goes too, under the same job key.
	if extra := slices.DeleteFunc(slices.Clone(swept), func(id int64) bool { _, ok := set[id]; return ok }); len(extra) > 0 {
		if _, _, err := h.purgeMessageIDs(ctx, &h.tombstones.unfinishedErasures, []int64{jobID}, extra); err != nil {
			return err
		}
	}
	slog.Info("hub: replay purged for erased messages", "buffered", dropped, "persisted", rows)
	return nil
}

// PurgeUserFromReplay takes every frame naming userID out of the replay pipeline after an erasure:
// drain the loop so the member_ban is sequenced, then purgeReplay tombstones the user, moves the
// purge watermark to the current seq (a client resuming from before it takes the full ready) and
// drops the ring's copies under seqMu, then deletes rows after releasing it. Idempotent; retried
// from the erasure journal.
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

// purgeReplay keeps seqMu short: drain the dispatch loop; take the purge lock (keeps cold-tier
// reads out until the rows are gone); under seqMu install tombstones and drop ring copies, so no
// frame naming them is sequenced from here on; release seqMu; flush the persister so every frame
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

// purgePersisted flushes the persister so every frame sequenced before the tombstones is on disk,
// then deletes the persisted rows.
func (h *Hub) purgePersisted(ctx context.Context, deleteRows func(context.Context) (int64, error)) (rows int64, err error) {
	if p := h.events.eventPersister.Load(); p != nil {
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

// awaitDispatch returns once every broadcast enqueued before the call is sequenced, buffered and
// handed to the persister, including gate-parked content. BroadcastToAll is asynchronous, so a
// caller purging replay behind a member_ban needs this first. A hub whose loop is not running has
// nothing to wait for.
func (h *Hub) awaitDispatch(ctx context.Context) error {
	if !h.lifecycle.running.Load() || !h.DispatchAlive() {
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

func eventNamesUser(data []byte, userID int64) bool {
	refs, ok := parseFrameRefs(data)
	if !ok {
		return false
	}
	_, hit := userIn(&refs, map[int64]struct{}{userID: {}})
	return hit
}

// messageFamily lists the frame types that carry or name a message's content: what a retention
// purge removes and a tombstone drops.
var messageFamily = map[string]struct{}{
	MsgTypeChatMessage:         {},
	MsgTypeChatEdited:          {},
	MsgTypeChatDeleted:         {},
	MsgTypeChatBulkDeleted:     {},
	MsgTypeReactionUpdate:      {},
	MsgTypePollUpdate:          {},
	MsgTypeMessageLinkPreviews: {},
}

func eventNamesMessage(data []byte, ids map[int64]struct{}) bool {
	refs, ok := parseFrameRefs(data)
	return ok && messageIn(&refs, ids)
}

// persistEvent enqueues a broadcast for cold storage; safe with a nil persister, never blocks. seq
// is the hub counter embedded in payload so the row-seq matches the client's payload-seq.
func (h *Hub) persistEvent(seq uint64, channelID int64, payload []byte) {
	p := h.events.eventPersister.Load()
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

// extractEventType scans a wrapped envelope for the literal `"type":"<value>"` token, "" on
// failure. Deliberately not a JSON decode: it matches every envelope this server produces and
// keeps a decode's allocations off the broadcast hot path.
func extractEventType(payload []byte) string {
	return string(eventTypeBytes(payload))
}

// frameIsContentBearing is contentBearingKinds[extractEventType(payload)] without the string: a
// map index on string(bytes) does not allocate.
func frameIsContentBearing(payload []byte) bool {
	return contentBearingKinds[string(eventTypeBytes(payload))]
}

// eventTypeBytes is extractEventType's scan; the result aliases payload, nil on failure.
func eventTypeBytes(payload []byte) []byte {
	const needle = `"type":"`
	idx := bytes.Index(payload, []byte(needle))
	if idx < 0 {
		return nil
	}
	start := idx + len(needle)
	end := bytes.IndexByte(payload[start:], '"')
	if end < 0 {
		return nil
	}
	t := payload[start : start+end]
	// Reject control chars or escapes (a clean label, not arbitrary user metadata); length-capped.
	if len(t) == 0 || len(t) > 64 {
		return nil
	}
	for _, b := range t {
		if b < 0x20 || b == '\\' {
			return nil
		}
	}
	return t
}

func sequenceable(msg []byte) bool {
	return len(msg) >= 2 && len(msg) <= config.MaxMessageBytes && msg[0] == '{'
}

func wrapWithSeq(msg []byte, seq uint64) []byte {
	// Fast path: inject seq after the opening brace. Frames above config.MaxMessageBytes pass
	// through unsequenced; the bound keeps the capacity arithmetic below overflow-free.
	if !sequenceable(msg) {
		return msg
	}
	// `{"seq":` + up to 20 digits + `,` is at most 28 extra bytes; the single make is the only
	// allocation on this hot path.
	result := make([]byte, 0, len(msg)+28)
	result = append(result, `{"seq":`...)
	result = strconv.AppendUint(result, seq, 10)
	result = append(result, ',')
	result = append(result, msg[1:]...) // skip opening brace
	return result
}
