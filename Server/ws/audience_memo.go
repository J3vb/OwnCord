package ws

import (
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// audienceMemoMaxAge bounds how long a memoised audience is reused when no
// generation moved; the permission cache TTL backstops a missed invalidation.
const audienceMemoMaxAge = 10 * time.Second

// audienceMemo keeps the last resolved read audience per channel and moderator
// set, so a burst of frames resolves once.
// An entry is reused only while the permission, connection and channel-flag
// generations match and it is younger than audienceMemoMaxAge. Entries are
// immutable; sync.Map holds them, so no hub lock is taken.
type audienceMemo struct {
	channels sync.Map // audienceMemoKey -> *audienceMemoEntry
	mods     sync.Map // struct{} -> *audienceMemoEntry
	// stores counts channel stores; every audienceMemoPruneEvery-th drops stale
	// entries so deleted channels do not leak.
	stores atomic.Uint64
}

const audienceMemoPruneEvery = 256

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

func (e *audienceMemoEntry) fresh(ref permissions.ChannelRef, permGen, connGen uint64, now time.Time) bool {
	return e.ref == ref && e.permGen == permGen && e.connGen == connGen &&
		now.Sub(e.at) < audienceMemoMaxAge
}

// memoGens snapshots the generations a memo entry is checked against. ok is false
// on a bare test hub without a PermissionService (nothing is memoised).
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

func (h *Hub) connectedSnapshot() (userIDs []int64, connGen uint64) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.connectedUserIDsLocked(), h.connGen.Load()
}

// storeIfUnchanged keeps a resolution only when no invalidation ran meanwhile; a
// racing resolution may hold a pre-change verdict.
func (h *Hub) storeIfUnchanged(m *sync.Map, key any, ref permissions.ChannelRef, permGen, connGen uint64, at time.Time, audience []int64) {
	if h.perms.Generation() != permGen {
		return
	}
	m.Store(key, &audienceMemoEntry{
		ref: ref, permGen: permGen, connGen: connGen, at: at,
		audience: slices.Clip(slices.Clone(audience)),
	})
	if m == &h.audience.channels && h.audience.stores.Add(1)%audienceMemoPruneEvery == 0 {
		h.pruneChannelAudiences(at)
	}
}

func (h *Hub) pruneChannelAudiences(now time.Time) {
	h.audience.channels.Range(func(key, v any) bool {
		if e, _ := v.(*audienceMemoEntry); e == nil || now.Sub(e.at) >= audienceMemoMaxAge {
			h.audience.channels.CompareAndDelete(key, v)
		}
		return true
	})
}

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

func (h *Hub) forgetChannelAudience(channelID int64) {
	h.audience.channels.Delete(audienceMemoKey{channelID: channelID})
	h.audience.channels.Delete(audienceMemoKey{channelID: channelID, ignoreArchived: true})
}
