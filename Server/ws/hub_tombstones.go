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

// tombstoneMinAge is how long a tombstone outlives its purge at least: it only drops a late frame
// from a producer that read the purged rows before the purge, which reaches the hub within moments.
const tombstoneMinAge = time.Hour

// tombstoneBatch is one purge's ids, installed at hub seq seq and wall-clock time at, in lookup map
// set.
type tombstoneBatch struct {
	seq uint64
	at  time.Time
	set map[int64]uint64
	ids []int64
}

// replayPurgeState holds the replay purge's tombstones and the lock that keeps cold-tier reads out
// of an in-progress purge.
// users and messages map each tombstoned id to the seq of the latest batch installing it; batches
// lists installs oldest first, so expiry pops from the front. All are guarded by seqMu (installed
// and read under it by every sequencing path), so a frame naming a tombstoned id is dropped from
// the moment the purge's in-memory step releases seqMu. A batch expires once tombstoneMinAge has
// passed and the hub has sequenced more frames than the ring and cold tier can replay.
// mu is held for writing across a whole purge (ring drop to persisted-row delete). A cold-tier read
// (purgeGuardedStore) that finds it held, or a purge waiting, fails at once so a resume takes the
// full ready rather than read rows the ring dropped but the database still holds. A purge failing
// after its ring drop leaves its ids in unfinished, and cold reads keep failing until a retry
// succeeds. Lock order: mu before seqMu; no path takes mu while holding seqMu.
type replayPurgeState struct {
	mu       syncutil.RankedRW[lockRankSerialiser]
	waiting  atomic.Int32
	users    map[int64]uint64
	messages map[int64]uint64
	batches  []tombstoneBatch
	now      func() time.Time

	// live is len(batches), so the sequencing path can ask whether any tombstone exists without
	// seqMu. Written under seqMu, read lock-free.
	live atomic.Int64
	// lockedParses counts frames parsed under seqMu because they could not be parsed before it.
	lockedParses atomic.Uint64

	unfinishedUsers    map[int64]struct{}
	unfinishedMessages map[int64]struct{}
}

// lock takes mu for a purge, giving up when ctx ends. It polls rather than blocks so a purge can
// return on its own deadline; waiting turns new cold reads away, so reconnects cannot starve it.
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

// tryColdRead takes mu for a cold-tier read, or reports a purge is running, waiting or unfinished.
// The caller RUnlocks.
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

// settlePurge records whether a purge of ids finished; the caller holds mu.
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

// add installs ids into set as one batch at seq; the caller holds seqMu.
func (t *replayPurgeState) add(set *map[int64]uint64, seq uint64, ids ...int64) {
	if *set == nil {
		*set = make(map[int64]uint64, len(ids))
	}
	for _, id := range ids {
		(*set)[id] = seq
	}
	t.batches = append(t.batches, tombstoneBatch{seq: seq, at: t.clock(), set: *set, ids: slices.Clone(ids)})
	t.live.Add(1)
}

// expire pops every batch older than tombstoneMinAge and more than horizon frames behind seq,
// removing ids no later batch reinstalled. Caller holds seqMu.
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
		t.live.Add(-1)
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

type preParsedRefs struct {
	refs frameRefs
	ok   bool
}

// parseRefsBeforeLock parses msg ahead of seqMu when a tombstone exists, so the lock holds set
// lookups only; nil when there is nothing to check (dropsForTombstonesWith then parses under the
// lock if one appeared since). Runs without seqMu.
func (h *Hub) parseRefsBeforeLock(msg []byte) *preParsedRefs {
	if h.tombstones.live.Load() == 0 {
		return nil
	}
	refs, ok := parseFrameRefs(msg)
	return &preParsedRefs{refs: refs, ok: ok}
}

// dropsForTombstones reports whether msg names an erased user or a swept message and so must not be
// sequenced (a producer that read the rows before the purge can still hand the hub a frame after
// it). Parsed once however many tombstones; none parses nothing. Caller holds seqMu.
func (h *Hub) dropsForTombstones(msg []byte) bool {
	return h.dropsForTombstonesWith(msg, nil)
}

// dropsForTombstonesWith is dropsForTombstones with refs the caller parsed before seqMu (nil parses
// here). Emptiness is judged under the lock either way, so a tombstone installed after the caller's
// check still drops the frame. Caller holds seqMu.
func (h *Hub) dropsForTombstonesWith(msg []byte, pre *preParsedRefs) bool {
	t := &h.tombstones
	if len(t.users) == 0 && len(t.messages) == 0 {
		return false
	}
	if pre == nil {
		t.lockedParses.Add(1)
		refs, ok := parseFrameRefs(msg)
		pre = &preParsedRefs{refs: refs, ok: ok}
	}
	if !pre.ok {
		return false
	}
	refs := &pre.refs
	if uid, hit := refs.userIn(t.users); hit {
		slog.Info("hub: dropped a frame naming an erased user", "user_id", uid)
		return true
	}
	if refs.messageIn(t.messages) {
		slog.Info("hub: dropped a frame about a message that was removed")
		return true
	}
	return false
}

type frameRefs struct {
	Type    string `json:"type"`
	Payload struct {
		ID         *int64  `json:"id"`
		MessageID  *int64  `json:"message_id"`
		IDs        []int64 `json:"ids"`
		UserID     *int64  `json:"user_id"`
		FromUserID *int64  `json:"from_user_id"`
		Mentions   []int64 `json:"mentions"`
		Call       *struct {
			Participants []int64 `json:"participants"`
		} `json:"call"`
		GroupEvent *struct {
			TargetUserID *int64 `json:"target_user_id"`
		} `json:"group_event"`
		User *struct {
			ID int64 `json:"id"`
		} `json:"user"`
		Updates []struct {
			UserID int64 `json:"user_id"`
		} `json:"updates"`
		Members []struct {
			UserID int64 `json:"user_id"`
		} `json:"members"`
		Thread *struct {
			OwnerID *int64 `json:"owner_id"`
		} `json:"thread"`
		Referenced *struct {
			ID   int64 `json:"id"`
			User *struct {
				ID int64 `json:"id"`
			} `json:"user"`
		} `json:"referenced_message"`
	} `json:"payload"`
}

// parseFrameRefs decodes data once; an unparseable frame names nothing. A field of an unexpected
// JSON type is skipped so one odd field does not hide the ids in the others.
func parseFrameRefs(data []byte) (frameRefs, bool) {
	var f frameRefs
	var typeErr *json.UnmarshalTypeError
	if err := json.Unmarshal(data, &f); err != nil && !errors.As(err, &typeErr) {
		return f, false
	}
	return f, true
}

// userIn returns the first user the frame names that is a key of set (user ids in the payload,
// replied-to author, mentions, call participants, group_event target, thread owner, updates[] and members[]).
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
	if pl.Thread != nil && pl.Thread.OwnerID != nil {
		ids = append(ids, *pl.Thread.OwnerID)
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
	for _, m := range pl.Members {
		ids = append(ids, m.UserID)
	}
	for _, id := range ids {
		if _, ok := set[id]; ok {
			return id, true
		}
	}
	return 0, false
}

func (f *frameRefs) userIn(set map[int64]uint64) (int64, bool) { return userIn(f, set) }

// messageIn reports whether the frame is a message-family frame about a key of set (payload.id,
// message_id, ids[], or the replied-to message).
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

// addMessageIDs adds the message ids a message-family frame names to set.
func (f *frameRefs) addMessageIDs(set map[int64]struct{}) {
	if _, ok := messageFamily[f.Type]; !ok {
		return
	}
	pl := &f.Payload
	if pl.ID != nil {
		set[*pl.ID] = struct{}{}
	}
	if pl.MessageID != nil {
		set[*pl.MessageID] = struct{}{}
	}
	if pl.Referenced != nil {
		set[pl.Referenced.ID] = struct{}{}
	}
	for _, id := range pl.IDs {
		set[id] = struct{}{}
	}
}

func (f *frameRefs) messageIn(set map[int64]uint64) bool { return messageIn(f, set) }
