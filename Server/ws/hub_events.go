package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"sync/atomic"

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
	h.eventStore.Store(&s)
}

// SetPluginEventSink wires the plugin.EventSink so the hub fans out each
// sequenced broadcast to subscribed plugins. Pass nil to disable. Safe to
// call at any time, including after Run has started.
//
// Deliberately still a setter after B3-4: the sink consumes the built hub's
// broadcaster (sink.SetBroadcaster(hub.BroadcastToChannel)), so it cannot
// exist before the hub does — a genuine two-phase wire, unlike the registry,
// which is a HubOptions field.
func (h *Hub) SetPluginEventSink(s *plugin.EventSink) {
	h.pluginSink.Store(s)
}

// ReconnectTierStats returns the per-tier resume hit counters in the order
// (buffer, db, full). Phase B Step 7 metrics surface; OpenTelemetry meters
// (Step 8) read from the same atomics.
func (h *Hub) ReconnectTierStats() (buffer, db, full uint64) {
	return h.reconnectTierBuf.Load(), h.reconnectTierDB.Load(), h.reconnectTierFull.Load()
}

// mustFullResync reports whether a client resuming from lastSeq predates the
// most recent channel-visibility change and therefore cannot converge via
// replay.
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

// dropsForPurgedUser reports whether msg names an erased user and must not
// be sequenced: a producer that read its rows before the erasure committed
// can still hand the hub a frame after the purge barrier. Caller holds
// seqMu. Cheap until the first purge: an empty set parses nothing.
func (h *Hub) dropsForPurgedUser(msg []byte) bool {
	if len(h.purgedUsers) == 0 {
		return false
	}
	for id := range h.purgedUsers {
		if eventNamesUser(msg, id) {
			slog.Info("hub: dropped a frame naming an erased user", "user_id", id)
			return true
		}
	}
	return false
}

// dropsForPurgedMessage reports whether msg is about a message the last
// retention sweep removed and must not be sequenced (dropsForPurgedUser's
// twin for messages). Caller holds seqMu; an empty set parses nothing.
func (h *Hub) dropsForPurgedMessage(msg []byte) bool {
	if len(h.purgedMessages) == 0 {
		return false
	}
	if eventNamesMessage(msg, h.purgedMessages) {
		slog.Info("hub: dropped a frame about a message retention removed")
		return true
	}
	return false
}

// PurgeMessagesFromReplay takes every frame about the given messages out of
// the replay pipeline after a retention sweep removed them (B4-11): the
// dispatch loop is drained and the persister flushed so a frame queued
// before the sweep is where the purge can reach it, then under seqMu the
// ids become the tombstone set (a frame about them that a producer
// sequences from now on is dropped), the ring buffer's copies are dropped
// and the persisted rows are deleted. A client resuming across the holes
// this leaves falls through the ring's gap rule and the cold tier's row
// count to the full ready, which no longer holds the messages. Idempotent;
// the sweep journals the ids until this succeeds.
func (h *Hub) PurgeMessagesFromReplay(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	if err := h.awaitDispatch(ctx); err != nil {
		return fmt.Errorf("purge replay: %w", err)
	}
	if p := h.eventPersister.Load(); p != nil {
		if err := p.Flush(ctx); err != nil {
			return fmt.Errorf("purge replay: flush: %w", err)
		}
	}
	set := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	h.seqMu.Lock()
	defer h.seqMu.Unlock()
	h.purgedMessages = set
	dropped := h.replayBuf.RemoveWhere(func(data []byte) bool { return eventNamesMessage(data, set) })
	var rows int64
	if h.db != nil {
		n, err := h.db.DeleteEventsForMessages(ctx, ids)
		if err != nil {
			return fmt.Errorf("purge replay: %w", err)
		}
		rows = n
	}
	slog.Info("hub: replay purged for swept messages", "messages", len(ids), "buffered", dropped, "persisted", rows)
	return nil
}

// PurgeUserFromReplay takes every frame naming userID out of the replay
// pipeline after an account erasure (data-lifecycle O5, HP-4 decision 1),
// in the order the pipeline runs: the dispatch loop is drained so the
// member_ban the erasure broadcast is sequenced, the persister is flushed so
// a frame queued before the erasure is on disk rather than in flight, then
// under seqMu — so no broadcast is sequenced in between — the user joins
// the tombstone set (a frame naming them that any producer sequences from
// now on is dropped, dropsForPurgedUser), the replay-purge watermark moves
// to the current seq (a client resuming from before it takes the full
// ready), the ring buffer's copies are dropped and the persisted rows are
// deleted. Idempotent and retried from the erasure journal on failure.
func (h *Hub) PurgeUserFromReplay(ctx context.Context, userID int64) error {
	if err := h.awaitDispatch(ctx); err != nil {
		return fmt.Errorf("purge replay: %w", err)
	}
	if p := h.eventPersister.Load(); p != nil {
		if err := p.Flush(ctx); err != nil {
			return fmt.Errorf("purge replay: flush: %w", err)
		}
	}
	h.seqMu.Lock()
	defer h.seqMu.Unlock()
	if h.purgedUsers == nil {
		h.purgedUsers = make(map[int64]struct{})
	}
	h.purgedUsers[userID] = struct{}{}
	h.bumpReplayPurgeWatermark()
	dropped := h.replayBuf.RemoveWhere(func(data []byte) bool { return eventNamesUser(data, userID) })
	var rows int64
	if h.db != nil {
		n, err := h.db.DeleteEventsForUser(ctx, userID)
		if err != nil {
			return fmt.Errorf("purge replay: %w", err)
		}
		rows = n
	}
	slog.Info("hub: replay purged for erased user", "user_id", userID, "buffered", dropped, "persisted", rows)
	return nil
}

// awaitDispatch returns once every broadcast enqueued on h.broadcast before
// the call has been through deliverBroadcast — sequenced, buffered and
// handed to the persister. BroadcastToAll is asynchronous, so the caller
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

// eventNamesUser reports whether a wrapped broadcast frame names userID —
// the Go twin of db.EventNamesUserPredicate over the same envelope shape:
// payload.user_id, payload.user.id, payload.from_user_id, or userID among
// payload.mentions. An unparseable frame names nobody.
func eventNamesUser(data []byte, userID int64) bool {
	var frame struct {
		Payload struct {
			UserID     *int64  `json:"user_id"`
			FromUserID *int64  `json:"from_user_id"`
			Mentions   []int64 `json:"mentions"`
			User       *struct {
				ID int64 `json:"id"`
			} `json:"user"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(data, &frame); err != nil {
		return false
	}
	pl := frame.Payload
	return (pl.UserID != nil && *pl.UserID == userID) ||
		(pl.FromUserID != nil && *pl.FromUserID == userID) ||
		(pl.User != nil && pl.User.ID == userID) ||
		slices.Contains(pl.Mentions, userID)
}

// messageFamily lists the frame types that carry a message's content or
// name one: what a retention purge removes and a tombstone drops.
var messageFamily = map[string]struct{}{
	MsgTypeChatMessage:     {},
	MsgTypeChatEdited:      {},
	MsgTypeChatDeleted:     {},
	MsgTypeChatBulkDeleted: {},
	MsgTypeReactionUpdate:  {},
}

// eventNamesMessage reports whether a wrapped broadcast frame is a
// message-family frame about one of ids — the Go twin of
// db.EventNamesMessagePredicate over the same envelope shape: payload.id
// (chat_message), payload.message_id (chat_edited, chat_deleted,
// reaction_update) or one of payload.ids (chat_bulk_deleted). An
// unparseable frame is about nothing.
func eventNamesMessage(data []byte, ids map[int64]struct{}) bool {
	var frame struct {
		Type    string `json:"type"`
		Payload struct {
			ID        *int64  `json:"id"`
			MessageID *int64  `json:"message_id"`
			IDs       []int64 `json:"ids"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(data, &frame); err != nil {
		return false
	}
	if _, ok := messageFamily[frame.Type]; !ok {
		return false
	}
	pl := frame.Payload
	if pl.ID != nil {
		if _, ok := ids[*pl.ID]; ok {
			return true
		}
	}
	if pl.MessageID != nil {
		if _, ok := ids[*pl.MessageID]; ok {
			return true
		}
	}
	for _, id := range pl.IDs {
		if _, ok := ids[id]; ok {
			return true
		}
	}
	return false
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

// wrapWithSeq injects a "seq" field into a JSON message without re-serializing.
func wrapWithSeq(msg []byte, seq uint64) []byte {
	// Fast path: inject seq after the opening brace.
	// e.g., {"type":"chat_message",...} → {"seq":123,"type":"chat_message",...}
	// Guard: msg must be a non-empty JSON object (starts with '{' and has content).
	if len(msg) < 2 || msg[0] != '{' {
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
