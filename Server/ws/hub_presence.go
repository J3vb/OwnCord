package ws

import (
	"cmp"
	"log/slog"
	"slices"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// presenceBatchPayload is presence_batch: a window batch lists users whose presence changed; a Full
// snapshot lists every connected user and anyone left out is offline.
type presenceBatchPayload struct {
	Updates []presenceBatchEntry `json:"updates"`
	Full    bool                 `json:"full,omitempty"`
}

// presenceBatchEntry is one user's presence in a batch or snapshot; CustomStatus, Activity and
// Listening follow presencePayload (always present, null when unset).
type presenceBatchEntry struct {
	UserID       int64              `json:"user_id"`
	Status       string             `json:"status"`
	CustomStatus *string            `json:"custom_status"`
	Activity     *gameActivity      `json:"activity"`
	Listening    *listeningActivity `json:"listening"`
	// Mobile is true on the Android app; omitted when false and blank on an entry whose status was
	// mapped to offline.
	Mobile bool `json:"mobile,omitempty"`
}

func memberPayloadFor(user *db.User, roleName string, roleIDs []int64) memberJoinUser {
	return memberJoinUser{
		ID:                user.ID,
		Username:          user.Username,
		Avatar:            user.Avatar,
		Role:              roleName,
		DisplayName:       user.DisplayName,
		IdentityPublicKey: user.IdentityPublicKey,
		About:             user.About,
		CreatedAt:         db.FormatMemberCreatedAt(user.CreatedAt),
		RoleIDs:           roleIDs,
		Banner:            user.BannerPath(),
		BannerColor:       user.BannerColor,
	}
}

// Three broadcastMsg fields carry presence (hub_broadcast.go): presence (a coalescing window's
// entries, built into presence_batch under seqMu); droppable (a client with a full normal queue
// drops the frame and is marked stale instead of disconnected; new-member data goes ahead as a
// content-class member_join, since the repairing snapshot has none); presenceSnapshot (a request:
// every presence-stale client gets a full snapshot).

// publishGlobal fans a sequenced global frame out to every client but bm.excludeUserID, in the
// frame's class. private holds a presence batch's per-subject variants: an invisible user gets
// their own true entry under the same seq.
func (h *Hub) publishGlobal(bm broadcastMsg, msg []byte, seq uint64, private map[int64][]byte) {
	priority := PriorityNormal
	if bm.droppable {
		priority = PriorityPresence
	}
	var allow func(int64) bool
	if private != nil {
		allow = func(uid int64) bool { return private[uid] == nil }
	}
	h.pubsub.publishWithPriority(TopicGlobal, msg, bm.excludeUserID, priority, allow)
	for uid, own := range private {
		for _, c := range h.clientsOf(uid) {
			c.sendPresenceMsg(wrapWithSeq(own, seq))
		}
	}
}

type presenceRepairState struct {
	drops    atomic.Uint64 // process-lifetime count (PresenceDropCount)
	staleAny atomic.Bool   // some client owes a snapshot at the next flush
	lostAll  atomic.Bool   // a presence frame was refused by the full dispatch queue
	// users holds whoever dropped a presence frame since their last full ready (their next resume
	// takes it). joins holds users owed a member_join: marked on a first-ever connect before the
	// stamp erases the signal, cleared once the member_join is queued, so a failed handshake still
	// announces next connect. mu is a leaf lock.
	mu    syncutil.Ranked[lockRankLeaf]
	users map[resyncKey]struct{} // per device session: a resume of another device cannot clear it
	joins map[int64]struct{}
}

func (s *presenceRepairState) mark(set *map[int64]struct{}, userID int64, on bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if on {
		if *set == nil {
			*set = make(map[int64]struct{})
		}
		(*set)[userID] = struct{}{}
	} else {
		delete(*set, userID)
	}
}

// resyncKey names one device session: the owed full ready belongs to the session whose frame was
// dropped, not the account.
type resyncKey struct {
	userID    int64
	tokenHash string
}

func (s *presenceRepairState) markResync(k resyncKey, on bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, had := s.users[k]
	if on {
		if s.users == nil {
			s.users = make(map[resyncKey]struct{})
		}
		s.users[k] = struct{}{}
	} else {
		delete(s.users, k)
	}
	return had
}

func (s *presenceRepairState) markedResync(k resyncKey) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.users[k]
	return ok
}

func (s *presenceRepairState) marked(set *map[int64]struct{}, userID int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := (*set)[userID]
	return ok
}

// pendingPresence is the coalescer's latest-wins entry for one user. member, when set, is
// member_join data other clients' lists lack; it goes out ahead of the window's batch.
type pendingPresence struct {
	status       string
	customStatus *string
	// activity is nil from every caller: a connect starts without a game and a disconnect ends it.
	activity  *gameActivity
	listening *listeningActivity // nil from every caller, like activity
	// mobile is the connecting user's merged phone flag; false for a disconnect.
	mobile bool
	// connecting is the connection this entry announces: queuePresence reads its phone flag under
	// presenceFeed.mu so a presence_update that landed first is not overtaken.
	connecting *Client
	member     *memberJoinUser
}

// QueuePresence coalesces connect/disconnect presence: the latest state per user is buffered for
// presenceCoalesceWindow, then flushed as one sequenced presence_batch (one frame per subject was
// N^2 in a reconnect herd, kicking slow clients and feeding the herd). Chosen status changes
// (presence_update) bypass it.
func (h *Hub) QueuePresence(userID int64, status string, customStatus *string) {
	h.queuePresence(userID, pendingPresence{status: status, customStatus: customStatus})
}

func (h *Hub) queuePresence(userID int64, p pendingPresence) {
	h.presenceFeed.mu.Lock()
	if h.presenceFeed.queue == nil {
		h.presenceFeed.queue = make(map[int64]pendingPresence)
	}
	if p.member == nil {
		p.member = h.presenceFeed.queue[userID].member
	}
	if p.connecting != nil {
		p.mobile = h.connectMobile(p.connecting, p.status)
		p.connecting = nil
	}
	h.presenceFeed.queue[userID] = p
	armed := h.presenceFeed.flushArmed
	h.presenceFeed.flushArmed = true
	h.presenceFeed.mu.Unlock()
	if !armed {
		time.AfterFunc(presenceCoalesceWindow, h.flushPresenceQueue)
	}
}

// presenceCoalesceWindow is long enough to collapse a socket flap and a herd's arrivals, short
// enough that an arrival still looks immediate.
const presenceCoalesceWindow = 300 * time.Millisecond

// presenceFlushRaceHook runs per flushPresenceQueue call after the queue is snapshotted and
// cleared, with presenceFeed.mu held. Test-only. It receives the Hub being flushed and an installer
// MUST ignore other Hubs' calls: the hook is package-global, and a sibling test's stray 300ms
// AfterFunc flush could fire into it (a run-once hook would panic). Atomic because that flush reads
// it from a timer goroutine.
var presenceFlushRaceHook atomic.Pointer[func(*Hub)]

// dropQueuedPresenceAndBroadcast atomically removes any coalesced presence queued for userID and
// runs broadcast, both under presenceFeed.mu. Used when a fresher presence is delivered directly
// (presence_update), so delete and send cannot straddle flushPresenceQueue's snapshot-and-enqueue.
// Whichever of this and flush takes the lock second also enqueues second: this first deletes the
// entry before flush snapshots it; flush first makes the delete a no-op, but the broadcast waits
// for flush's batch, so the fresher frame gets the higher seq from the single FIFO consumer.
// A dropped entry that carried member data still owes the member_join, sent ahead of the fresher
// frame. broadcast only does a non-blocking enqueue onto h.broadcast, so it adds no lock-order
// edge.
func (h *Hub) dropQueuedPresenceAndBroadcast(userID int64, broadcast func()) {
	h.presenceFeed.mu.Lock()
	defer h.presenceFeed.mu.Unlock()
	h.dropQueuedPresenceLocked(userID)
	broadcast()
}

// dropQueuedPresenceLocked drops userID's queued presence. The caller holds presenceFeed.mu and
// broadcasts only after its own check.
func (h *Hub) dropQueuedPresenceLocked(userID int64) {
	if p, ok := h.presenceFeed.queue[userID]; ok && p.member != nil {
		h.announceMember(userID, p)
	}
	delete(h.presenceFeed.queue, userID)
}

// announceMember enqueues the member_join for a member other clients' lists may lack, in the
// content class (presence may be dropped and the repairing snapshot carries no member data). Called
// with presenceFeed.mu held, ahead of the member's presence frame.
func (h *Hub) announceMember(userID int64, p pendingPresence) {
	msg := buildJSON(wsMsg{Type: MsgTypeMemberJoin, Payload: memberJoinPayload{
		User:   *p.member,
		Status: db.BroadcastStatus(p.status),
	}})
	if h.enqueue(broadcastMsg{msg: msg}, "member_join") {
		h.presenceFeed.repair.mark(&h.presenceFeed.repair.joins, userID, false)
	}
}

// flushPresenceQueue drains the coalescer into one presence_batch, preceded by a member_join per
// new member, and asks for a snapshot for every client that dropped presence. A batch or request
// the full dispatch queue refuses is repaired: a lost batch marks every connected client stale (and
// via recordQueueDrop sends older resumes to the full ready); a lost request is retried a window
// later. Runs on the AfterFunc timer goroutine.
// presenceFeed.mu is held across the batch's enqueue so a concurrent dropQueuedPresenceAndBroadcast
// serializes with it and both reach h.broadcast in critical-section order.
func (h *Hub) flushPresenceQueue() {
	h.presenceFeed.mu.Lock()
	queued := h.presenceFeed.queue
	h.presenceFeed.queue = nil
	h.presenceFeed.flushArmed = false
	if hook := presenceFlushRaceHook.Load(); hook != nil {
		(*hook)(h)
	}
	lost := false
	// An offline entry for a user who has connected since is stale (the new online presence could
	// be coalesced away or ordered behind it): drop it. presenceFeed.mu -> Hub.mu (R) is in order.
	for uid, p := range queued {
		if p.status == db.StatusOffline && h.isConnected(uid) {
			delete(queued, uid)
		}
	}
	if len(queued) > 0 {
		for uid, p := range queued {
			if p.member != nil {
				h.announceMember(uid, p)
			}
		}
		lost = !h.enqueue(broadcastMsg{presence: queued, droppable: true}, "presence_batch")
	}
	h.presenceFeed.mu.Unlock()
	if h.presenceFeed.repair.lostAll.Swap(false) {
		lost = true
	}
	if lost {
		h.mu.RLock()
		for _, c := range h.allClientsLocked() {
			c.presenceStale.Store(true)
		}
		h.mu.RUnlock()
		h.presenceFeed.repair.staleAny.Store(true)
	}
	if h.presenceFeed.repair.staleAny.Swap(false) && !h.enqueue(broadcastMsg{presenceSnapshot: true}, "presence snapshot") {
		h.presenceFeed.repair.staleAny.Store(true)
		time.AfterFunc(presenceCoalesceWindow, h.flushPresenceQueue)
	}
}

// buildPresenceBatch turns a window into the public presence_batch plus a private variant per
// invisible subject: others see db.BroadcastStatus with the custom text blanked (a tell), the
// subject sees the truth. Erased users are left out. Called under seqMu (guards tombstones); nil
// when nothing is left.
func (h *Hub) buildPresenceBatch(queued map[int64]pendingPresence) ([]byte, map[int64][]byte) {
	entries := make([]presenceBatchEntry, 0, len(queued))
	for uid, p := range queued {
		if h.tombstones.erased(uid) {
			continue
		}
		e := presenceBatchEntry{UserID: uid, Status: db.BroadcastStatus(p.status), CustomStatus: p.customStatus, Activity: p.activity, Listening: p.listening, Mobile: p.mobile}
		if e.Status != p.status {
			e.CustomStatus, e.Activity, e.Listening, e.Mobile = nil, nil, nil, false
		}
		entries = append(entries, e)
	}
	if len(entries) == 0 {
		return nil, nil
	}
	slices.SortFunc(entries, func(a, b presenceBatchEntry) int { return cmp.Compare(a.UserID, b.UserID) })
	var private map[int64][]byte
	for i, e := range entries {
		p := queued[e.UserID]
		if e.Status == p.status {
			continue
		}
		own := slices.Clone(entries)
		own[i].Status, own[i].CustomStatus, own[i].Activity, own[i].Listening, own[i].Mobile = p.status, p.customStatus, p.activity, p.listening, p.mobile
		if private == nil {
			private = make(map[int64][]byte)
		}
		private[e.UserID] = buildPresenceBatchMsg(own, false)
	}
	return buildPresenceBatchMsg(entries, false), private
}

// broadcastPresenceFrame enqueues one user's presence_update as a sequenced global frame on the
// same FIFO as the batches, in the presence class (a full queue drops it instead of kicking). A
// refused frame reached nobody, so the next flush snapshots every client; callers may hold
// presenceFeed.mu, so clients are marked there, not here.
func (h *Hub) broadcastPresenceFrame(excludeUserID int64, msg []byte) {
	if h.enqueue(broadcastMsg{msg: msg, excludeUserID: excludeUserID, droppable: true}, "presence") {
		return
	}
	if h.presenceFeed.repair.lostAll.CompareAndSwap(false, true) {
		time.AfterFunc(presenceCoalesceWindow, h.flushPresenceQueue)
	}
}

func buildPresenceBatchMsg(updates []presenceBatchEntry, full bool) []byte {
	return buildJSON(wsMsg{Type: MsgTypePresenceBatch, Payload: presenceBatchPayload{Updates: updates, Full: full}})
}

// presenceDropped records that the session of userID dropped a presence frame: the next flush sends
// it a snapshot and the user's next resume takes the full ready, because the dropped seq sits below
// later ones the client may ack. Lock-free apart from the leaf presenceRepairState.mu; callers may
// hold seqMu, ps.mu or presenceFeed.mu (Client.sendPresenceMsg releases c.mu first).
func (h *Hub) presenceDropped(userID int64, tokenHash string) {
	h.presenceFeed.repair.drops.Add(1)
	h.presenceFeed.repair.markResync(resyncKey{userID, tokenHash}, true)
	if h.presenceFeed.repair.staleAny.CompareAndSwap(false, true) {
		time.AfterFunc(presenceCoalesceWindow, h.flushPresenceQueue)
	}
}

func (h *Hub) presenceResyncPending(userID int64, tokenHash string) bool {
	return h.presenceFeed.repair.markedResync(resyncKey{userID, tokenHash})
}

func (h *Hub) setPresenceResync(userID int64, tokenHash string, pending bool) bool {
	return h.presenceFeed.repair.markResync(resyncKey{userID, tokenHash}, pending)
}

// deliverPresenceSnapshots sends every presence-stale client a full presence_batch: each connected
// user not offline to it, with live custom status, its own true presence included (anyone absent
// reads offline, so an invisible user looks unconnected). Unsequenced and droppable again. Runs on
// the dispatch goroutine, so it lands after every presence frame already sequenced.
func (h *Hub) deliverPresenceSnapshots() {
	h.mu.RLock()
	var stale []*Client
	for _, c := range h.allClientsLocked() {
		if c.presenceStale.Load() {
			stale = append(stale, c)
		}
	}
	h.mu.RUnlock()
	if len(stale) == 0 {
		return
	}
	live := h.livePresences()
	public := make([]presenceBatchEntry, 0, len(live))
	for uid, p := range live {
		if s := db.BroadcastStatus(p.status); s != "" && s != db.StatusOffline {
			public = append(public, presenceBatchEntry{UserID: uid, Status: s, CustomStatus: p.customStatus, Activity: p.activity, Listening: p.listening, Mobile: p.mobile})
		}
	}
	slices.SortFunc(public, func(a, b presenceBatchEntry) int { return cmp.Compare(a.UserID, b.UserID) })
	shared := buildPresenceBatchMsg(public, true)
	for _, c := range stale {
		c.presenceStale.Store(false)
		msg := shared
		i, listed := slices.BinarySearchFunc(public, c.userID, func(e presenceBatchEntry, uid int64) int { return cmp.Compare(e.UserID, uid) })
		if p := live[c.userID]; !listed && p.status != "" && p.status != db.StatusOffline {
			own := slices.Insert(slices.Clone(public), i, presenceBatchEntry{UserID: c.userID, Status: p.status, CustomStatus: p.customStatus, Activity: p.activity, Listening: p.listening, Mobile: p.mobile})
			msg = buildPresenceBatchMsg(own, true)
		}
		c.sendPresenceMsg(msg)
	}
	slog.Debug("hub: presence snapshots sent", "clients", len(stale))
}

// applyPresenceChoice records a presence_update and returns the events to emit. A chosen status
// (online, dnd, invisible) is stamped on every connection of the user, the sender last, so the
// newest choice wins the merge whatever an older device chose; each keeps its own idle tracking. An
// idle update is the sender's own auto-idle and stamps only that connection.
// The outgoing presence follows the merged state, not the sender's raw status (an idle device must
// not show the user idle while another is active); an auto-idle that leaves the shown status
// unchanged emits nothing.
func (h *Hub) applyPresenceChoice(c *Client, p *livePresence, events []Event) []Event {
	before := mergeLivePresence(h.clientsOf(c.userID))
	if !isIdleStatus(p.status) {
		for _, o := range h.clientsOf(c.userID) {
			if o != c {
				o.stampChosenStatus(p.status, p.customStatus, p.customStatusExpiresAt)
			}
		}
	}
	c.setLivePresence(p.status, p.customStatus, p.customStatusExpiresAt)
	merged := mergeLivePresence(h.clientsOf(c.userID))
	if isIdleStatus(p.status) && merged.status == before.status && merged.mobile == before.mobile && sameText(merged.customStatus, before.customStatus) {
		return nil
	}
	// The handler's events carry the sender's raw status and no phone flag, so they stand only when
	// the merged presence is not on the phone.
	if merged.status == p.status && !merged.mobile && sameText(merged.customStatus, p.customStatus) {
		return events // the update is what is shown: the handler's events stand
	}
	return presenceEvents(c.userID, merged.status, merged.customStatus, merged.activity, merged.listening, merged.mobile)
}

func sameText(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
