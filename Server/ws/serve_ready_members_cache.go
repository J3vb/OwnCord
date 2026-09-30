package ws

import (
	"bytes"
	"context"
	"encoding/json"
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
// connected member's live status instead, so a cached row's status never
// shows: a member whose connection has not stamped one yet shows as offline.
type memberCache struct {
	mu      syncutil.Mutex
	filled  bool
	gen     int64
	lapseAt string        // NextMemberBanLapse at the read; "" = none pending
	roster  *memberRoster // shared by every caller: read-only
	flight  singleflight.Group
}

// memberRoster is one generation's member list with each member's JSON
// encoded once (P5-O01), so a ready writes it instead of re-encoding the
// whole roster per viewer.
type memberRoster struct {
	members []db.MemberSummary
	enc     []memberJSON // enc[i] encodes members[i]
}

// memberJSON is one member's encoding split around the two fields
// presentableMembers decides per viewer: head, the status, mid, then the
// custom_status (last), then "}" is json.Marshal of the presented member.
type memberJSON struct {
	head   []byte // `{"id":…,"status":`
	mid    []byte // `,"role":…,"custom_status":`
	custom []byte // the encoded custom_status; nil when unset
}

var (
	emptyStatusField = []byte(`"status":""`)
	nullCustomTail   = []byte(`"custom_status":null}`)
)

// encodeRoster encodes every member once. The split points are found in
// json.Marshal's own output, so the verbatim parts follow MemberSummary's
// tags. A string value cannot hold emptyStatusField: its quotes would be
// escaped.
func encodeRoster(members []db.MemberSummary) (*memberRoster, error) {
	enc := make([]memberJSON, len(members))
	for i, m := range members {
		custom := m.CustomStatus
		m.Status, m.CustomStatus = "", nil
		b, err := json.Marshal(m)
		if err != nil {
			return nil, fmt.Errorf("encodeRoster: %w", err)
		}
		at := bytes.Index(b, emptyStatusField)
		if at < 0 || !bytes.HasSuffix(b, nullCustomTail) {
			return nil, fmt.Errorf("encodeRoster: member %d: status or custom_status is not where the splice expects", m.ID)
		}
		enc[i].head = b[:at+len(emptyStatusField)-len(`""`)]
		enc[i].mid = b[at+len(emptyStatusField) : len(b)-len("null}")]
		if custom != nil {
			if enc[i].custom, err = json.Marshal(*custom); err != nil {
				return nil, fmt.Errorf("encodeRoster: %w", err)
			}
		}
	}
	return &memberRoster{members: members, enc: enc}, nil
}

// sqliteNow renders the current instant as ListMembers' ban-lapse comparison
// renders SQLite's clock, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), so a lapse
// ends the cached list on the same second a fresh read would include it.
func sqliteNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05Z")
}

// lookup returns the cached roster when it is at least as new as gen and no
// ban it hides has lapsed since.
func (c *memberCache) lookup(gen int64) (*memberRoster, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.filled || c.gen < gen || (c.lapseAt != "" && sqliteNow() >= c.lapseAt) {
		return nil, false
	}
	return c.roster, true
}

// store keeps roster as the cached one unless a read at a newer generation
// already landed: a slow read that started before a write must not replace
// the list read after it.
func (c *memberCache) store(gen int64, lapseAt string, roster *memberRoster) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.filled && c.gen > gen {
		return
	}
	c.filled, c.gen, c.lapseAt, c.roster = true, gen, lapseAt, roster
}

// readyMembers returns the member roster for one ready payload, shared with
// every concurrent and later ready at the same member generation. The roster
// is shared: callers copy before changing an element (presentableMembers
// does).
//
// The generation is read before the list, so the list is never older than
// its tag: a write committing in between makes the list newer than the tag
// claims, which costs one extra read later and never a stale one. Callers
// that read the same generation share one flight: a caller that read
// generation g started after every member write up to g committed, and the
// flight for g read its list after that too.
func (h *Hub) readyMembers(ctx context.Context, database ReadySnapshotReader) (*memberRoster, error) {
	gen, err := database.MemberGeneration(ctx)
	if err != nil {
		return nil, err
	}
	if roster, ok := h.members.lookup(gen); ok {
		return roster, nil
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
		roster, err := encodeRoster(members)
		if err != nil {
			return nil, err
		}
		h.members.store(gen, lapseAt, roster)
		return roster, nil
	})
	if err != nil {
		return nil, err
	}
	roster, ok := v.(*memberRoster)
	if !ok {
		return nil, fmt.Errorf("readyMembers: unexpected flight result %T", v)
	}
	return roster, nil
}
