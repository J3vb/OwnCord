package ws

import (
	"encoding/json"
	"log/slog"
	"slices"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// tombstoneMinAge is how long a tombstone outlives its purge at least. Its
// only job once the purge has run is to drop a late frame from a producer
// that read the purged rows before the purge, which reaches the hub within
// moments; an hour is far past any request.
const tombstoneMinAge = time.Hour

// tombstone records when an id was purged: the hub seq at the purge and the
// wall-clock time.
type tombstone struct {
	seq uint64
	at  time.Time
}

// replayPurgeState holds the replay purge's tombstones and the lock that
// keeps cold-tier reads out of an in-progress purge.
//
// users (erased accounts) and messages (retention-swept messages) are
// guarded by seqMu: they are installed under it and read under it by every
// sequencing path, so a frame naming one is dropped from the moment the
// purge's in-memory step releases seqMu. They expire once both
// tombstoneMinAge has passed and the hub has sequenced more frames past
// them than the ring and the cold tier can replay.
//
// mu is held for writing across a whole purge, from the ring drop to the
// persisted-row delete, and for reading by every cold-tier read
// (purgeGuardedStore), so a resume can never read rows the ring has already
// dropped but the database has not yet deleted. Lock order: mu before seqMu;
// no path takes mu while holding seqMu.
type replayPurgeState struct {
	mu       syncutil.RWMutex
	users    map[int64]tombstone
	messages map[int64]tombstone
	now      func() time.Time
}

func (t *replayPurgeState) clock() time.Time {
	if t.now != nil {
		return t.now()
	}
	return time.Now()
}

// add installs ids into set at seq. Caller holds seqMu.
func (t *replayPurgeState) add(set *map[int64]tombstone, seq uint64, ids ...int64) {
	if *set == nil {
		*set = make(map[int64]tombstone, len(ids))
	}
	stone := tombstone{seq: seq, at: t.clock()}
	for _, id := range ids {
		(*set)[id] = stone
	}
}

// expire drops every tombstone that is older than tombstoneMinAge and more
// than horizon frames behind seq. Caller holds seqMu.
func (t *replayPurgeState) expire(seq, horizon uint64) (expired int) {
	cutoff := t.clock().Add(-tombstoneMinAge)
	for _, set := range []map[int64]tombstone{t.users, t.messages} {
		for id, stone := range set {
			if seq-stone.seq > horizon && stone.at.Before(cutoff) {
				delete(set, id)
				expired++
			}
		}
	}
	return expired
}

func (t *replayPurgeState) erased(userID int64) bool {
	_, ok := t.users[userID]
	return ok
}

// expireReplayTombstones runs tombstone expiry from the stale tick. The
// horizon is every frame the ring and the cold tier could replay.
func (h *Hub) expireReplayTombstones() {
	h.seqMu.Lock()
	start := time.Now()
	defer h.seqMu.Unlock()
	defer h.observeSeqMuHold(start)
	if len(h.tombstones.users) == 0 && len(h.tombstones.messages) == 0 {
		return
	}
	horizon := uint64(h.replayBuf.size + h.maxColdReplayLimit()) //nolint:gosec // both are small positive config values
	if n := h.tombstones.expire(atomic.LoadUint64(&h.seq), horizon); n > 0 {
		slog.Info("hub: replay tombstones expired", "count", n)
	}
}

// dropsForTombstones reports whether msg names an erased user or a message
// a retention sweep removed, and so must not be sequenced: a producer that
// read the rows before the purge can still hand the hub a frame after it.
// The frame is parsed once, whatever the number of tombstones. Caller holds
// seqMu; with no tombstones it parses nothing.
func (h *Hub) dropsForTombstones(msg []byte) bool {
	t := &h.tombstones
	if len(t.users) == 0 && len(t.messages) == 0 {
		return false
	}
	refs, ok := parseFrameRefs(msg)
	if !ok {
		return false
	}
	if uid, hit := refs.userIn(t.users); hit {
		slog.Info("hub: dropped a frame naming an erased user", "user_id", uid)
		return true
	}
	if refs.messageIn(t.messages) {
		slog.Info("hub: dropped a frame about a message retention removed")
		return true
	}
	return false
}

// frameRefs is the part of a wrapped broadcast frame that can name a user or
// a message: the Go twin of db.EventNamesUserPredicate and
// db.EventNamesMessagePredicate over the same envelope shape.
type frameRefs struct {
	Type    string `json:"type"`
	Payload struct {
		ID         *int64  `json:"id"`
		MessageID  *int64  `json:"message_id"`
		IDs        []int64 `json:"ids"`
		UserID     *int64  `json:"user_id"`
		FromUserID *int64  `json:"from_user_id"`
		Mentions   []int64 `json:"mentions"`
		User       *struct {
			ID int64 `json:"id"`
		} `json:"user"`
		Updates []struct {
			UserID int64 `json:"user_id"`
		} `json:"updates"`
		// A reply frame embeds its parent's snippet.
		Referenced *struct {
			ID   int64 `json:"id"`
			User *struct {
				ID int64 `json:"id"`
			} `json:"user"`
		} `json:"referenced_message"`
	} `json:"payload"`
}

// parseFrameRefs decodes data once; an unparseable frame names nothing.
func parseFrameRefs(data []byte) (frameRefs, bool) {
	var f frameRefs
	if err := json.Unmarshal(data, &f); err != nil {
		return f, false
	}
	return f, true
}

// userIn returns the first user the frame names that is a key of set:
// payload.user_id, payload.from_user_id, payload.user.id, the replied-to
// message's author, payload.mentions or payload.updates[].user_id.
func userIn[V any](f *frameRefs, set map[int64]V) (int64, bool) {
	pl := &f.Payload
	var ids []int64
	if pl.UserID != nil {
		ids = append(ids, *pl.UserID)
	}
	if pl.FromUserID != nil {
		ids = append(ids, *pl.FromUserID)
	}
	if pl.User != nil {
		ids = append(ids, pl.User.ID)
	}
	if pl.Referenced != nil && pl.Referenced.User != nil {
		ids = append(ids, pl.Referenced.User.ID)
	}
	ids = append(ids, pl.Mentions...)
	for _, u := range pl.Updates {
		ids = append(ids, u.UserID)
	}
	for _, id := range ids {
		if _, ok := set[id]; ok {
			return id, true
		}
	}
	return 0, false
}

func (f *frameRefs) userIn(set map[int64]tombstone) (int64, bool) { return userIn(f, set) }

// messageIn reports whether the frame is a message-family frame about a key
// of set: payload.id (chat_message), payload.message_id (chat_edited,
// chat_deleted, reaction_update), one of payload.ids (chat_bulk_deleted), or
// the replied-to message.
func messageIn[V any](f *frameRefs, set map[int64]V) bool {
	if _, ok := messageFamily[f.Type]; !ok {
		return false
	}
	pl := &f.Payload
	has := func(id int64) bool { _, ok := set[id]; return ok }
	switch {
	case pl.ID != nil && has(*pl.ID),
		pl.Referenced != nil && has(pl.Referenced.ID),
		pl.MessageID != nil && has(*pl.MessageID):
		return true
	}
	return slices.ContainsFunc(pl.IDs, has)
}

func (f *frameRefs) messageIn(set map[int64]tombstone) bool { return messageIn(f, set) }
