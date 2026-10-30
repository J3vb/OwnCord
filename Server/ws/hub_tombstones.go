package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// tombstoneMinAge is how long a tombstone outlives its purge at least. After the
// purge it only drops a late frame from a producer that read the purged rows before
// the purge, which reaches the hub within moments; an hour is far past any request.
const tombstoneMinAge = time.Hour

// tombstoneBatch is one purge's ids, installed at the hub seq seq and the
// wall-clock time at, in the lookup map set.
type tombstoneBatch struct {
	seq uint64
	at  time.Time
	set map[int64]uint64
	ids []int64
}

// replayPurgeState holds the replay purge's tombstones and the lock that keeps
// cold-tier reads out of an in-progress purge.
//
// users (erased accounts) and messages (retention-swept messages) map each
// tombstoned id to the seq of the latest batch that installed it; batches lists the
// installs oldest first, and since seq and time only grow, expiry pops from the
// front. All three are guarded by seqMu: installed under it and read under it by
// every sequencing path, so a frame naming a tombstoned id is dropped from the
// moment the purge's in-memory step releases seqMu. A batch expires once both
// tombstoneMinAge has passed and the hub has sequenced more frames past it than the
// ring and the cold tier can replay.
//
// mu is held for writing across a whole purge, from the ring drop to the
// persisted-row delete. A cold-tier read (purgeGuardedStore) that finds it held, or
// a purge waiting for it, fails at once instead of waiting, so a resume falls
// through to the full ready rather than reading rows the ring has dropped but the
// database still holds. A purge that fails after its ring drop leaves its ids in
// unfinished, and cold reads keep failing until a retry succeeds. Lock order: mu
// before seqMu; no path takes mu while holding seqMu.
type replayPurgeState struct {
	mu       syncutil.RankedRW[lockRankSerialiser]
	waiting  atomic.Int32
	users    map[int64]uint64
	messages map[int64]uint64
	batches  []tombstoneBatch
	now      func() time.Time

	unfinishedUsers    map[int64]struct{}
	unfinishedMessages map[int64]struct{}
}

// lock takes mu for a purge, giving up when ctx ends. It polls rather than
// blocks so a purge can return on its own deadline; waiting turns new cold
// reads away meanwhile, so a stream of reconnects cannot starve it.
func (t *replayPurgeState) lock(ctx context.Context) error {
	t.waiting.Add(1)
	defer t.waiting.Add(-1)
	for !t.mu.TryLock() {
		select {
		case <-ctx.Done():
			return fmt.Errorf("purge replay: wait for cold reads: %w", ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	return nil
}

// tryColdRead takes mu for a cold-tier read, or reports that a purge is
// running, waiting or unfinished. The caller releases mu with RUnlock.
func (t *replayPurgeState) tryColdRead() bool {
	if t.waiting.Load() > 0 || !t.mu.TryRLock() {
		return false
	}
	if t.waiting.Load() > 0 || len(t.unfinishedUsers) > 0 || len(t.unfinishedMessages) > 0 {
		t.mu.RUnlock()
		return false
	}
	return true
}

// settlePurge records whether a purge of ids finished. Caller holds mu.
func settlePurge(set *map[int64]struct{}, ids []int64, finished bool) {
	if finished {
		for _, id := range ids {
			delete(*set, id)
		}
		return
	}
	if *set == nil {
		*set = make(map[int64]struct{}, len(ids))
	}
	for _, id := range ids {
		(*set)[id] = struct{}{}
	}
}

func (t *replayPurgeState) clock() time.Time {
	if t.now != nil {
		return t.now()
	}
	return time.Now()
}

// add installs ids into set as one batch at seq. Caller holds seqMu.
func (t *replayPurgeState) add(set *map[int64]uint64, seq uint64, ids ...int64) {
	if *set == nil {
		*set = make(map[int64]uint64, len(ids))
	}
	for _, id := range ids {
		(*set)[id] = seq
	}
	t.batches = append(t.batches, tombstoneBatch{seq: seq, at: t.clock(), set: *set, ids: slices.Clone(ids)})
}

// expire pops every batch that is older than tombstoneMinAge and more than
// horizon frames behind seq, removing each of its ids no later batch has
// installed again. Caller holds seqMu.
func (t *replayPurgeState) expire(seq, horizon uint64) (expired int) {
	cutoff := t.clock().Add(-tombstoneMinAge)
	for len(t.batches) > 0 {
		b := t.batches[0]
		if seq-b.seq <= horizon || !b.at.Before(cutoff) {
			break
		}
		for _, id := range b.ids {
			if b.set[id] == b.seq {
				delete(b.set, id)
				expired++
			}
		}
		t.batches[0] = tombstoneBatch{}
		t.batches = t.batches[1:]
	}
	if len(t.batches) == 0 {
		t.batches = nil
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
	if len(h.tombstones.batches) == 0 {
		return
	}
	horizon := uint64(h.replayBuf.size + h.maxColdReplayLimit()) //nolint:gosec // both are small positive config values
	if n := h.tombstones.expire(atomic.LoadUint64(&h.seq), horizon); n > 0 {
		slog.Info("hub: replay tombstones expired", "count", n)
	}
}

// dropsForTombstones reports whether msg names an erased user or a message a
// retention sweep removed, and so must not be sequenced: a producer that read the
// rows before the purge can still hand the hub a frame after it. The frame is parsed
// once however many tombstones; with none it parses nothing. Caller holds seqMu.
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
		// A call log row lists the users who joined the call.
		Call *struct {
			Participants []int64 `json:"participants"`
		} `json:"call"`
		// A group add or remove row names the member it concerns.
		GroupEvent *struct {
			TargetUserID *int64 `json:"target_user_id"`
		} `json:"group_event"`
		User *struct {
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

// parseFrameRefs decodes data once; an unparseable frame names nothing. A
// field of an unexpected JSON type is skipped and the rest still decoded,
// so one odd field does not hide the ids the other fields carry.
func parseFrameRefs(data []byte) (frameRefs, bool) {
	var f frameRefs
	var typeErr *json.UnmarshalTypeError
	if err := json.Unmarshal(data, &f); err != nil && !errors.As(err, &typeErr) {
		return f, false
	}
	return f, true
}

// userIn returns the first user the frame names that is a key of set:
// payload.user_id, payload.from_user_id, payload.user.id, the replied-to
// message's author, payload.mentions, payload.call.participants, payload.group_event.target_user_id or payload.updates[].user_id.
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
	if pl.Call != nil {
		ids = append(ids, pl.Call.Participants...)
	}
	if pl.GroupEvent != nil && pl.GroupEvent.TargetUserID != nil {
		ids = append(ids, *pl.GroupEvent.TargetUserID)
	}
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

func (f *frameRefs) userIn(set map[int64]uint64) (int64, bool) { return userIn(f, set) }

// messageIn reports whether the frame is a message-family frame about a key
// of set: payload.id (chat_message), payload.message_id (chat_edited,
// chat_deleted, reaction_update, poll_update), one of payload.ids (chat_bulk_deleted), or
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

func (f *frameRefs) messageIn(set map[int64]uint64) bool { return messageIn(f, set) }
