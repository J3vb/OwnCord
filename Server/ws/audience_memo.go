package ws

import (
	"slices"
	"sync"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// audienceMemoMaxAge bounds how long a memoised audience is reused even when no
// generation moved. The permission cache's own TTL is the backstop for a missed
// invalidation; this keeps the memo from outliving it by much.
const audienceMemoMaxAge = 10 * time.Second

// audienceMemo keeps the last resolved read audience per channel and the last
// resolved moderator set, so a burst of frames for one channel resolves its
// audience once instead of once per connected user per frame.
//
// An entry is reused only while the permission cache's generation, the hub's
// connection generation and the channel flags it was resolved for all still
// match, and it is younger than audienceMemoMaxAge. Entries are immutable once
// stored; sync.Map holds them, so no hub lock is taken here.
type audienceMemo struct {
	channels sync.Map // audienceMemoKey -> *audienceMemoEntry
	mods     sync.Map // struct{} -> *audienceMemoEntry
}

type audienceMemoKey struct {
	channelID      int64
	ignoreArchived bool
}

type audienceMemoEntry struct {
	ref      permissions.ChannelRef
	permGen  uint64
	connGen  uint64
	at       time.Time
	audience []int64
}

// fresh reports whether e may stand in for a resolution made now.
func (e *audienceMemoEntry) fresh(ref permissions.ChannelRef, permGen, connGen uint64, now time.Time) bool {
	return e.ref == ref && e.permGen == permGen && e.connGen == connGen &&
		now.Sub(e.at) < audienceMemoMaxAge
}

// memoGens snapshots the two generations a memo entry is checked against. ok is
// false on a bare test hub without a PermissionService: its live lookups have no
// generation, so nothing is memoised there.
func (h *Hub) memoGens() (permGen, connGen uint64, ok bool) {
	if h.perms == nil {
		return 0, 0, false
	}
	permGen = h.perms.Generation()
	h.mu.RLock()
	connGen = h.connGen.Load()
	h.mu.RUnlock()
	return permGen, connGen, true
}

// connectedSnapshot lists the connected users with the connection generation
// that set belongs to, read under one hold of h.mu.
func (h *Hub) connectedSnapshot() (userIDs []int64, connGen uint64) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.connectedUserIDsLocked(), h.connGen.Load()
}

// storeIfUnchanged keeps a resolution only when no invalidation ran while it was
// being made; a resolution that raced one may hold a pre-change verdict.
func (h *Hub) storeIfUnchanged(m *sync.Map, key any, ref permissions.ChannelRef, permGen, connGen uint64, at time.Time, audience []int64) {
	if h.perms.Generation() != permGen {
		return
	}
	m.Store(key, &audienceMemoEntry{
		ref: ref, permGen: permGen, connGen: connGen, at: at,
		audience: slices.Clip(slices.Clone(audience)),
	})
}

// loadFresh returns a copy of a fresh entry's audience, or ok=false.
func loadFresh(m *sync.Map, key any, ref permissions.ChannelRef, permGen, connGen uint64, now time.Time) (audience []int64, ok bool) {
	v, found := m.Load(key)
	if !found {
		return nil, false
	}
	e, _ := v.(*audienceMemoEntry)
	if e == nil || !e.fresh(ref, permGen, connGen, now) {
		return nil, false
	}
	return slices.Clone(e.audience), true
}

// forgetChannelAudience drops a channel's memo entries (a deleted channel).
func (h *Hub) forgetChannelAudience(channelID int64) {
	h.audience.channels.Delete(audienceMemoKey{channelID: channelID})
	h.audience.channels.Delete(audienceMemoKey{channelID: channelID, ignoreArchived: true})
}
