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

// presenceBatchPayload is presence_batch. A window batch lists users whose
// presence changed; a Full snapshot lists every connected user and anyone left out
// is offline.
type presenceBatchPayload struct {
	Updates []presenceBatchEntry `json:"updates"`
	Full    bool                 `json:"full,omitempty"`
}

// presenceBatchEntry is one user's presence in a batch or snapshot. CustomStatus,
// Activity and Listening follow presencePayload: always present, null when unset.
type presenceBatchEntry struct {
	UserID       int64              `json:"user_id"`
	Status       string             `json:"status"`
	CustomStatus *string            `json:"custom_status"`
	Activity     *gameActivity      `json:"activity"`
	Listening    *listeningActivity `json:"listening"`
	// Mobile is true when the member is on the Android app; omitted when false and
	// always blank on an entry whose status was mapped to offline.
	Mobile bool `json:"mobile,omitempty"`
}

// memberPayloadFor is the member_join user object.
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

// Three broadcastMsg fields carry presence (hub_broadcast.go):
//   - presence, when non-nil, is a coalescing window's entries; deliverBroadcast
//     builds the presence_batch from them under seqMu (buildPresenceBatch).
//   - droppable marks a presence-class frame: a client whose normal queue is full
//     drops it and is marked stale instead of being disconnected
//     (Client.sendPresenceMsg). Every presence_batch is droppable; a new member's
//     data goes ahead as a content-class member_join (announceMember), since the
//     snapshot that repairs a drop has none.
//   - presenceSnapshot makes the entry a request, like barrier: every
//     presence-stale client gets a full snapshot (deliverPresenceSnapshots).

// publishGlobal fans a sequenced global frame out to every connected client but
// bm.excludeUserID, in the frame's class. private holds a presence batch's
// per-subject variants (an invisible user's own true entry): that user gets theirs,
// under the same seq, instead of the public frame.
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

// presenceRepairState tracks presence frames clients dropped on a full queue
// (Client.sendPresenceMsg) and their repair.
type presenceRepairState struct {
	drops    atomic.Uint64 // process-lifetime count (PresenceDropCount)
	staleAny atomic.Bool   // some client owes a snapshot at the next flush
	lostAll  atomic.Bool   // a presence frame was refused by the full dispatch queue
	// users holds whoever dropped a presence frame since their last full ready; their
	// next resume takes the full ready. joins holds users owed a member_join: marked by
	// a first-ever connect before its stamp erases the signal (last_seen NULL), cleared
	// once the member_join is on the dispatch queue, so a handshake failing in between
	// still announces on the next connect. A restart needs no copy: every client then
	// takes a full ready. mu is a leaf lock: nothing is acquired while holding it.
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

// resyncKey names one device session: the owed full ready belongs to the session
// whose frame was dropped, not the account.
type resyncKey struct {
	userID    int64
	tokenHash string
}

// markResync sets (or clears) k in the owed-resync set and reports whether it was set.
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

// pendingPresence is the coalescer's latest-wins entry for one user. member, when
// set, is member_join data for a user other clients' lists lack; it goes out ahead
// of the window's batch and survives a later state in the window.
type pendingPresence struct {
	status       string
	customStatus *string
	// activity is nil from every caller: a connect starts without a game and a
	// disconnect ends it. An activity change is a live presence frame, not a coalesced entry.
	activity  *gameActivity
	listening *listeningActivity // nil from every caller, like activity
	// mobile is the connecting user's merged phone flag (mergeLivePresence); false
	// for a disconnect.
	mobile bool
	member *memberJoinUser
}

// QueuePresence coalesces connect/disconnect presence: the latest state per user
// is buffered for presenceCoalesceWindow, then flushed as one sequenced
// presence_batch. One frame per subject to every client was N^2 frames in a
// reconnect herd on a 256-slot queue, kicking slow clients and feeding the herd
// back. Latest-wins: a flap inside the window collapses to its final state.
// User-chosen status changes (presence_update) do not pass through here.
func (h *Hub) QueuePresence(userID int64, status string, customStatus *string) {
	h.queuePresence(userID, pendingPresence{status: status, customStatus: customStatus})
}

func (h *Hub) queuePresence(userID int64, p pendingPresence) {
	h.presenceMu.Lock()
	if h.presenceQueue == nil {
		h.presenceQueue = make(map[int64]pendingPresence)
	}
	if p.member == nil {
		p.member = h.presenceQueue[userID].member
	}
	h.presenceQueue[userID] = p
	armed := h.presenceFlushArmed
	h.presenceFlushArmed = true
	h.presenceMu.Unlock()
	if !armed {
		time.AfterFunc(presenceCoalesceWindow, h.flushPresenceQueue)
	}
}

// presenceCoalesceWindow is how long QueuePresence buffers presence before
// flushing: long enough to collapse a socket flap and a herd's arrivals, short
// enough that an arrival still looks immediate.
const presenceCoalesceWindow = 300 * time.Millisecond

// presenceFlushRaceHook, when non-nil, runs once per flushPresenceQueue call right
// after the coalesced queue is snapshotted and cleared, with presenceMu held.
// Test-only: the window is too narrow to land a concurrent
// dropQueuedPresenceAndBroadcast reliably.
//
// It is handed the Hub being flushed and an installer MUST ignore other Hubs'
// calls. The hook is package-global but flushes are per-Hub, and QueuePresence's
// AfterFunc outlives the arming test (dropQueuedPresenceAndBroadcast clears the
// queue without disarming the timer), so a sibling test's 300ms flush can fire
// into whatever hook is installed by then; a hook that is safe to run only once
// (closing a channel) would panic. It is atomic because that stray flush reads
// it from a timer goroutine while a test installs or clears it.
var presenceFlushRaceHook atomic.Pointer[func(*Hub)]

// dropQueuedPresenceAndBroadcast atomically removes any coalesced presence queued
// for userID and runs broadcast, both under presenceMu. Called when a fresher
// presence for that user is delivered directly (presence_update via EmitEvents),
// so the delete and the send cannot straddle flushPresenceQueue's
// snapshot-and-enqueue section.
//
// Holding presenceMu across the delete and the broadcast is what closes the race:
// whichever of this call and flushPresenceQueue acquires it second also enqueues
// second.
//   - This call first: it deletes the entry before flush can snapshot it, so flush
//     never broadcasts the stale state.
//   - Flush first: the delete is a no-op, but the broadcast cannot run until
//     flush's batch is enqueued, so the fresher frame gets the higher seq from
//     deliverBroadcast's single FIFO consumer and every client converges on it.
//
// A dropped entry that carried member data still owes other clients the member: it
// goes out as a member_join ahead of the fresher frame. broadcast runs under
// presenceMu: every caller only does a non-blocking enqueue onto h.broadcast, so
// it cannot block and adds no lock-order edge.
func (h *Hub) dropQueuedPresenceAndBroadcast(userID int64, broadcast func()) {
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	h.dropQueuedPresenceLocked(userID)
	broadcast()
}

// dropQueuedPresenceLocked is the drop half of dropQueuedPresenceAndBroadcast, for
// a caller already holding presenceMu that broadcasts only after its own check.
func (h *Hub) dropQueuedPresenceLocked(userID int64) {
	if p, ok := h.presenceQueue[userID]; ok && p.member != nil {
		h.announceMember(userID, p)
	}
	delete(h.presenceQueue, userID)
}

// announceMember enqueues the member_join for a member other clients' lists may
// lack, in the content class: presence may be dropped and the snapshot repairing a
// drop carries no member data. Once on the dispatch queue the user is no longer
// owed one. Called with presenceMu held, ahead of the member's presence frame.
func (h *Hub) announceMember(userID int64, p pendingPresence) {
	msg := buildJSON(wsMsg{Type: MsgTypeMemberJoin, Payload: memberJoinPayload{
		User:   *p.member,
		Status: db.BroadcastStatus(p.status),
	}})
	if h.enqueue(broadcastMsg{msg: msg}, "member_join") {
		h.presenceRepair.mark(&h.presenceRepair.joins, userID, false)
	}
}

// flushPresenceQueue drains the coalescer into one presence_batch, preceded by a
// member_join for each new member, and asks for a snapshot for every client that
// dropped presence since the last flush. A batch or snapshot request the full
// dispatch queue refuses is repaired the same way: a lost batch marks every
// connected client stale (and via recordQueueDrop sends a resume from before it to
// the full ready); a lost request is retried a window later. Runs on the AfterFunc
// timer goroutine.
//
// presenceMu is held across the batch's enqueue, not just the snapshot, so a
// concurrent dropQueuedPresenceAndBroadcast serializes with it and the batch and
// the fresher frame reach h.broadcast in critical-section order.
func (h *Hub) flushPresenceQueue() {
	h.presenceMu.Lock()
	queued := h.presenceQueue
	h.presenceQueue = nil
	h.presenceFlushArmed = false
	if hook := presenceFlushRaceHook.Load(); hook != nil {
		(*hook)(h)
	}
	lost := false
	// An offline entry for a user who has connected since is stale: the new
	// connection's online presence could be coalesced away or ordered behind it. Drop
	// it (presenceMu -> Hub.mu (R) is in order).
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
	h.presenceMu.Unlock()
	if h.presenceRepair.lostAll.Swap(false) {
		lost = true
	}
	if lost {
		h.mu.RLock()
		for _, c := range h.allClientsLocked() {
			c.presenceStale.Store(true)
		}
		h.mu.RUnlock()
		h.presenceRepair.staleAny.Store(true)
	}
	if h.presenceRepair.staleAny.Swap(false) && !h.enqueue(broadcastMsg{presenceSnapshot: true}, "presence snapshot") {
		h.presenceRepair.staleAny.Store(true)
		time.AfterFunc(presenceCoalesceWindow, h.flushPresenceQueue)
	}
}

// buildPresenceBatch turns a window's entries into the public presence_batch plus
// a private variant for each invisible subject: others see
// db.BroadcastStatus(status) with the custom text blanked (it would be a tell),
// the subject sees the truth. Erased users are left out. Called under seqMu,
// which guards the tombstones; nil when nothing is left.
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

// broadcastPresenceFrame enqueues one user's presence (presence_update) as a
// sequenced global frame on the same dispatch FIFO as the batches, in the presence
// class: a full queue drops it instead of kicking the client. A refused frame
// reached nobody, so the next flush snapshots every client; callers may hold
// presenceMu, so the clients are marked there, not here.
func (h *Hub) broadcastPresenceFrame(excludeUserID int64, msg []byte) {
	if h.enqueue(broadcastMsg{msg: msg, excludeUserID: excludeUserID, droppable: true}, "presence") {
		return
	}
	if h.presenceRepair.lostAll.CompareAndSwap(false, true) {
		time.AfterFunc(presenceCoalesceWindow, h.flushPresenceQueue)
	}
}

func buildPresenceBatchMsg(updates []presenceBatchEntry, full bool) []byte {
	return buildJSON(wsMsg{Type: MsgTypePresenceBatch, Payload: presenceBatchPayload{Updates: updates, Full: full}})
}

// presenceDropped records that the session tokenHash of userID dropped a presence
// frame: the next flush sends that client a snapshot and the user's next resume
// takes the full ready, because the dropped seq sits below later ones the client
// may still ack. Lock-free apart from the leaf presenceRepairState.mu.
// Client.sendPresenceMsg releases the client's mu before calling this, but its
// callers may hold seqMu, ps.mu or presenceMu.
func (h *Hub) presenceDropped(userID int64, tokenHash string) {
	h.presenceRepair.drops.Add(1)
	h.presenceRepair.markResync(resyncKey{userID, tokenHash}, true)
	if h.presenceRepair.staleAny.CompareAndSwap(false, true) {
		time.AfterFunc(presenceCoalesceWindow, h.flushPresenceQueue)
	}
}

// presenceResyncPending reports whether userID's connection dropped a presence
// frame since their last full ready.
func (h *Hub) presenceResyncPending(userID int64, tokenHash string) bool {
	return h.presenceRepair.markedResync(resyncKey{userID, tokenHash})
}

// setPresenceResync marks (or clears) userID's pending resync and reports whether
// one was pending.
func (h *Hub) setPresenceResync(userID int64, tokenHash string, pending bool) bool {
	return h.presenceRepair.markResync(resyncKey{userID, tokenHash}, pending)
}

// deliverPresenceSnapshots sends every presence-stale client a full presence_batch:
// each connected user not offline to that client, with live custom status, its
// own true presence included; anyone absent is offline, so an invisible user reads
// like one with no connection. Unsequenced like other targeted repair frames, and
// droppable again (a still-full queue stays stale). Runs on the dispatch
// goroutine, so it lands after every presence frame already sequenced and reads a
// registry no older than them.
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

// applyPresenceChoice records the presence a presence_update set and returns the
// events to emit. A chosen status (online, dnd, invisible) is stamped on every
// connection of the user, the sender last, so the newest choice wins the merge
// (mergeLivePresence) whatever an older device chose; each connection keeps its
// own idle tracking. An idle update is the sender's own auto-idle and stamps only
// that connection.
//
// The outgoing presence follows the merged state, not the sender's raw status: an
// idle device must not show the user idle while another is active. An auto-idle
// that leaves the shown status and text unchanged emits nothing.
func (h *Hub) applyPresenceChoice(c *Client, p *livePresence, events []Event) []Event {
	before := mergeLivePresence(h.clientsOf(c.userID))
	if !isIdleStatus(p.status) {
		for _, o := range h.clientsOf(c.userID) {
			if o != c {
				o.setLivePresence(p.status, p.customStatus, p.customStatusExpiresAt)
			}
		}
	}
	c.setLivePresence(p.status, p.customStatus, p.customStatusExpiresAt)
	merged := mergeLivePresence(h.clientsOf(c.userID))
	if isIdleStatus(p.status) && merged.status == before.status && merged.mobile == before.mobile && sameText(merged.customStatus, before.customStatus) {
		return nil
	}
	// The handler's events are built from the sender's raw status and never carry the
	// phone flag, so they stand only when the merged presence is not on the phone.
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
