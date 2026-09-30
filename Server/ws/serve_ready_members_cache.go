package ws

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// memberCache is the ready payload's shared member-list read (DP-37). A
// restart herd builds hundreds of ready payloads at once, and each used to
// run its own ListMembers: the whole roster, joined and sorted, per socket.
//
// The cached list is tagged with the member generation it was read at, a
// counter SQLite triggers bump in the same commit as every write that can
// change ListMembers' result (migration 057). It is reused only while the
// generation has not moved and no temporary ban it hides has lapsed. Never a
// TTL: a client that registered after a join's broadcast would miss the
// join for as long as a TTL let it be served a list from before it.
//
// users.status is outside the generation, since every connect writes it and
// a herd would then never share a read. presentableMembers overlays each
// connected member's live status instead, so a cached row's status only ever
// shows for a connection that has not stamped one yet.
type memberCache struct {
	mu      syncutil.Mutex
	filled  bool
	gen     int64
	lapseAt string             // NextMemberBanLapse at the read; "" = none pending
	members []db.MemberSummary // shared by every caller: read-only
	flight  singleflight.Group
}

// sqliteNow renders the current instant as ListMembers' ban-lapse comparison
// renders SQLite's clock, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), so a lapse
// ends the cached list on the same second a fresh read would include it.
func sqliteNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05Z")
}

// lookup returns the cached list when it is at least as new as gen and no
// ban it hides has lapsed since.
func (c *memberCache) lookup(gen int64) ([]db.MemberSummary, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.filled || c.gen < gen || (c.lapseAt != "" && sqliteNow() >= c.lapseAt) {
		return nil, false
	}
	return c.members, true
}

// store keeps members as the cached list unless a read at a newer generation
// already landed: a slow read that started before a write must not replace
// the list read after it.
func (c *memberCache) store(gen int64, lapseAt string, members []db.MemberSummary) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.filled && c.gen > gen {
		return
	}
	c.filled, c.gen, c.lapseAt, c.members = true, gen, lapseAt, members
}

// readyMembers returns the member roster for one ready payload, shared with
// every concurrent and later ready at the same member generation. The slice
// is shared: callers copy before changing an element (presentableMembers
// does).
//
// The generation is read before the list, so the list is never older than
// its tag: a write committing in between makes the list newer than the tag
// claims, which costs one extra read later and never a stale one. Callers
// that read the same generation share one flight: a caller that read
// generation g started after every member write up to g committed, and the
// flight for g read its list after that too.
func (h *Hub) readyMembers(ctx context.Context, database ReadySnapshotReader) ([]db.MemberSummary, error) {
	gen, err := database.MemberGeneration(ctx)
	if err != nil {
		return nil, err
	}
	if members, ok := h.members.lookup(gen); ok {
		return members, nil
	}
	v, err, _ := h.members.flight.Do(strconv.FormatInt(gen, 10), func() (any, error) {
		// Detached from the first caller's handshake: that client giving up
		// mid-herd must not fail every other ready waiting on this read.
		readCtx := context.WithoutCancel(ctx)
		// Before the list, so a ban lapsing between the two reads ends the
		// cached list early rather than never.
		lapseAt, err := database.NextMemberBanLapse(readCtx)
		if err != nil {
			return nil, err
		}
		members, err := database.ListMembers(readCtx)
		if err != nil {
			return nil, err
		}
		h.members.store(gen, lapseAt, members)
		return members, nil
	})
	if err != nil {
		return nil, err
	}
	members, ok := v.([]db.MemberSummary)
	if !ok {
		return nil, fmt.Errorf("readyMembers: unexpected flight result %T", v)
	}
	return members, nil
}
