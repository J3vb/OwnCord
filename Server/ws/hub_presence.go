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

// presenceBatchPayload is presence_batch: many users' presence in one frame.
// A coalescing-window batch lists the users whose presence changed
// ([]presenceBatchEntry); a Full snapshot lists every connected user
// ([]presenceSnapshotEntry), and anyone it leaves out is offline.
type presenceBatchPayload struct {
	Updates any  `json:"updates"`
	Full    bool `json:"full,omitempty"`
}

// presenceBatchEntry is one user's presence in a window batch. CustomStatus
// follows presencePayload's rule: always present, null when unset.
type presenceBatchEntry struct {
	UserID       int64   `json:"user_id"`
	Status       string  `json:"status"`
	CustomStatus *string `json:"custom_status"`
}

// presenceSnapshotEntry is one user's presence in a Full snapshot. It has no
// custom_status: the hub keeps no live copy of the text, so the client leaves
// it alone (and clears it for anyone offline).
type presenceSnapshotEntry struct {
	UserID int64  `json:"user_id"`
	Status string `json:"status"`
}

// memberPayloadFor is the member_join user object: what a client's member
// list needs to add the member.
func memberPayloadFor(user *db.User, roleName string) memberUserPayload {
	return memberUserPayload{
		ID:                user.ID,
		Username:          user.Username,
		Avatar:            user.Avatar,
		Role:              roleName,
		DisplayName:       user.DisplayName,
		IdentityPublicKey: user.IdentityPublicKey,
	}
}

// Three broadcastMsg fields carry presence (hub_broadcast.go):
//   - presence, when non-nil, is a coalescing window's entries: deliverBroadcast
//     builds the presence_batch from them under seqMu (buildPresenceBatch).
//   - droppable marks a presence-class frame: a client whose normal queue is
//     full drops it and is marked stale instead of being disconnected
//     (Client.sendPresenceMsg). Every presence_batch is droppable; a new
//     member's data goes ahead of it as a content-class member_join
//     (announceMember), since the snapshot that repairs a drop has none.
//   - presenceSnapshot makes the entry a request, like barrier: every client
//     marked presence-stale gets a full snapshot (deliverPresenceSnapshots).

// publishGlobal fans a sequenced global frame out to every connected client
// but bm.excludeUserID, in the frame's class. private holds a presence
// batch's per-subject variants (an invisible user's own true entry): that
// user gets theirs, under the same seq, instead of the public frame.
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
		if c := h.GetClient(uid); c != nil {
			c.sendPresenceMsg(wrapWithSeq(own, seq))
		}
	}
}

// presenceRepairState tracks presence frames clients dropped on a full queue
// (Client.sendPresenceMsg) and their repair.
type presenceRepairState struct {
	drops    atomic.Uint64 // process-lifetime count (PresenceDropCount)
	staleAny atomic.Bool   // some client owes a snapshot at the next flush
	// users holds whoever dropped a presence frame since their last full
	// ready; their next resume takes the full ready. joins holds the users
	// owed a member_join: marked by a first-ever connect before its stamp
	// erases the signal (last_seen NULL), cleared once the member_join is on
	// the dispatch queue, so a handshake that fails in between still
	// announces on the next connect. A restart needs no copy: every client
	// then takes a full ready listing every member. mu is a leaf lock:
	// nothing is acquired while holding it.
	mu    syncutil.Mutex
	users map[int64]struct{}
	joins map[int64]struct{}
}

// mark sets (or clears) userID in set, one of s's maps, and reports whether
// it was set.
func (s *presenceRepairState) mark(set *map[int64]struct{}, userID int64, on bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, had := (*set)[userID]
	if on {
		if *set == nil {
			*set = make(map[int64]struct{})
		}
		(*set)[userID] = struct{}{}
	} else {
		delete(*set, userID)
	}
	return had
}

// marked reports whether userID is in set, one of s's maps.
func (s *presenceRepairState) marked(set *map[int64]struct{}, userID int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := (*set)[userID]
	return ok
}

// pendingPresence is the coalescer's latest-wins entry for one user. member,
// when set, is the member_join data for a user other clients' member lists do
// not have yet; it goes out as a member_join ahead of the window's batch and
// survives a later state in the window.
type pendingPresence struct {
	status       string
	customStatus *string
	member       *memberUserPayload
}

// QueuePresence coalesces connect/disconnect presence: the latest state per
// user is buffered for presenceCoalesceWindow and then flushed as ONE
// sequenced presence_batch frame carrying every user that changed. One frame
// per subject used to reach every client — N² frames in a reconnect herd, on
// a 256-slot queue, which kicked the slow clients and fed the herd back
// (P5-S03). Latest-wins is presence's semantics: a flap inside the window
// collapses to its final state. User-chosen status changes (the
// presence_update handler) do not pass through here.
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

// presenceCoalesceWindow is how long QueuePresence buffers connect/disconnect
// presence before flushing. Long enough to collapse a socket flap
// (disconnect+reconnect through a proxy blip) into one entry and a herd's
// arrivals into a few frames, short enough that a genuine arrival still looks
// immediate to humans.
const presenceCoalesceWindow = 300 * time.Millisecond

// presenceFlushRaceHook, when non-nil, runs once per flushPresenceQueue call
// immediately after the coalesced queue has been snapshotted and cleared,
// while presenceMu is still held. Test-only (always nil in production): the
// snapshot-to-broadcast window is too narrow to land a real concurrent
// dropQueuedPresenceAndBroadcast reliably, so tests use this hook to
// reproduce that interleaving deterministically. Mirrors the established
// refreshChannelVisibilityRaceHook / voiceJoinPostTokenRaceHook pattern.
//
// It is handed the Hub being flushed, and a test that installs it MUST
// ignore calls for any other Hub. The hook is package-global but flushes are
// per-Hub, and QueuePresence's AfterFunc outlives the test that armed it:
// dropQueuedPresenceAndBroadcast clears the queue without disarming the
// timer, so a sibling test's 300ms flush fires long after that test returned
// — into whatever hook is installed by then. Passing the Hub is what lets the
// installer tell its own flush from that stray one; without it, a hook body
// that is only safe to run once (closing a channel, say) panics.
var presenceFlushRaceHook func(*Hub)

// dropQueuedPresenceAndBroadcast atomically removes any coalesced presence
// still queued for userID and runs broadcast, both under presenceMu. Called
// when a fresher presence for that user is delivered directly (the
// presence_update handler path, via EmitEvents), so the delete and the send
// of the fresher frame can never straddle flushPresenceQueue's own
// snapshot-and-enqueue critical section (OC-0005).
//
// Holding presenceMu across the delete AND the broadcast — rather than just
// the delete — is what actually closes the race: whichever of this call and
// flushPresenceQueue acquires presenceMu second also enqueues its broadcast
// second.
//   - If this call goes first, it deletes the entry before flush can ever
//     snapshot it, so flush never broadcasts the stale state at all.
//   - If flush goes first, this call's delete is a no-op against the
//     already-cleared queue, but its broadcast still cannot run until flush's
//     own batch has already been enqueued — so the fresher frame is stamped
//     with the higher seq by deliverBroadcast's single FIFO consumer and
//     every client's final view converges on it, not the stale one.
//
// A dropped entry that carried member data still owes other clients the
// member: it goes out as a member_join ahead of the fresher frame.
//
// broadcast runs with presenceMu held: every caller only enqueues onto
// h.broadcast's non-blocking channel send, so this cannot block and
// introduces no new lock-order edge.
func (h *Hub) dropQueuedPresenceAndBroadcast(userID int64, broadcast func()) {
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	if p, ok := h.presenceQueue[userID]; ok && p.member != nil {
		h.announceMember(userID, p)
	}
	delete(h.presenceQueue, userID)
	broadcast()
}

// announceMember enqueues the member_join for a member other clients' lists
// may not have yet, in the content class: presence may be dropped, and the
// snapshot that repairs a drop carries no member data. Once it is on the
// dispatch queue the user is no longer owed one. Called with presenceMu held,
// ahead of the frame that carries the member's presence.
func (h *Hub) announceMember(userID int64, p pendingPresence) {
	msg := buildJSON(wsMsg{Type: MsgTypeMemberJoin, Payload: memberJoinPayload{
		User:   *p.member,
		Status: db.BroadcastStatus(p.status),
	}})
	if h.enqueue(broadcastMsg{msg: msg}, "member_join") {
		h.presenceRepair.mark(&h.presenceRepair.joins, userID, false)
	}
}

// flushPresenceQueue drains the coalescer into one presence_batch, preceded
// by a member_join for each new member in it, and asks for a snapshot for
// every client that dropped presence since the last flush. A batch or
// snapshot request the full dispatch queue refuses is repaired the same way:
// a lost batch marks every connected client stale, and a lost request is
// retried a window later. Runs on the AfterFunc timer goroutine.
//
// presenceMu is held across the batch's enqueue, not just the snapshot, so a
// concurrent dropQueuedPresenceAndBroadcast serializes with it (OC-0005): the
// batch and the fresher frame reach h.broadcast in the order their critical
// sections ran, and deliverBroadcast's single consumer sequences them so.
func (h *Hub) flushPresenceQueue() {
	h.presenceMu.Lock()
	queued := h.presenceQueue
	h.presenceQueue = nil
	h.presenceFlushArmed = false
	if presenceFlushRaceHook != nil {
		presenceFlushRaceHook(h)
	}
	lost := false
	if len(queued) > 0 {
		for uid, p := range queued {
			if p.member != nil {
				h.announceMember(uid, p)
			}
		}
		lost = !h.enqueue(broadcastMsg{presence: queued, droppable: true}, "presence_batch")
	}
	h.presenceMu.Unlock()
	if lost {
		h.mu.RLock()
		for _, c := range h.clients {
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

// buildPresenceBatch turns a window's entries into the public presence_batch
// every client gets, plus a private variant for each invisible subject:
// others see db.BroadcastStatus(status) with the custom text blanked (the
// text would be a tell that an "offline" member is online), the subject sees
// the truth. Erased users' entries are left out. Called under seqMu, which
// guards purgedUsers; nil when nothing is left to send.
func (h *Hub) buildPresenceBatch(queued map[int64]pendingPresence) ([]byte, map[int64][]byte) {
	entries := make([]presenceBatchEntry, 0, len(queued))
	for uid, p := range queued {
		if _, purged := h.purgedUsers[uid]; purged {
			continue
		}
		e := presenceBatchEntry{UserID: uid, Status: db.BroadcastStatus(p.status), CustomStatus: p.customStatus}
		if e.Status != p.status {
			e.CustomStatus = nil
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
		own[i].Status, own[i].CustomStatus = p.status, p.customStatus
		if private == nil {
			private = make(map[int64][]byte)
		}
		private[e.UserID] = buildPresenceBatchMsg(own, false)
	}
	return buildPresenceBatchMsg(entries, false), private
}

// broadcastPresenceFrame enqueues one user's presence (the presence_update
// path) as a sequenced global frame on the same dispatch FIFO as the batches,
// in the presence class: a full queue drops it instead of kicking the client.
func (h *Hub) broadcastPresenceFrame(excludeUserID int64, msg []byte) {
	h.enqueue(broadcastMsg{msg: msg, excludeUserID: excludeUserID, droppable: true}, "presence")
}

func buildPresenceBatchMsg(updates any, full bool) []byte {
	return buildJSON(wsMsg{Type: MsgTypePresenceBatch, Payload: presenceBatchPayload{Updates: updates, Full: full}})
}

// presenceDropped records that userID's connection dropped a presence frame
// (Client.sendPresenceMsg): the next flush sends that client a snapshot, and
// the user's next resume takes the full ready, because the dropped seq sits
// below later ones the client may still see and ack. Lock-free apart from the
// leaf presenceResyncMu, since it runs under seqMu and the client's mu.
func (h *Hub) presenceDropped(userID int64) {
	h.presenceRepair.drops.Add(1)
	h.presenceRepair.mark(&h.presenceRepair.users, userID, true)
	if h.presenceRepair.staleAny.CompareAndSwap(false, true) {
		time.AfterFunc(presenceCoalesceWindow, h.flushPresenceQueue)
	}
}

// presenceResyncPending reports whether userID's connection dropped a
// presence frame since their last full ready.
func (h *Hub) presenceResyncPending(userID int64) bool {
	return h.presenceRepair.marked(&h.presenceRepair.users, userID)
}

// setPresenceResync marks (or clears) userID's pending resync and reports
// whether one was pending.
func (h *Hub) setPresenceResync(userID int64, pending bool) bool {
	return h.presenceRepair.mark(&h.presenceRepair.users, userID, pending)
}

// deliverPresenceSnapshots sends every presence-stale client a full
// presence_batch: each connected user's status as that client may see it,
// its own true status included; anyone absent is offline. Unsequenced, like
// the other targeted repair frames, and droppable again (a still-full queue
// just stays stale). Runs on the dispatch goroutine, so it lands after every
// presence frame already sequenced and reads a registry no older than them.
func (h *Hub) deliverPresenceSnapshots() {
	h.mu.RLock()
	var stale []*Client
	for _, c := range h.clients {
		if c.presenceStale.Load() {
			stale = append(stale, c)
		}
	}
	h.mu.RUnlock()
	if len(stale) == 0 {
		return
	}
	live := h.liveStatuses()
	public := make([]presenceSnapshotEntry, 0, len(live))
	for uid, s := range live {
		if s != "" {
			public = append(public, presenceSnapshotEntry{UserID: uid, Status: db.BroadcastStatus(s)})
		}
	}
	slices.SortFunc(public, func(a, b presenceSnapshotEntry) int { return cmp.Compare(a.UserID, b.UserID) })
	shared := buildPresenceBatchMsg(public, true)
	for _, c := range stale {
		c.presenceStale.Store(false)
		msg := shared
		if i, ok := slices.BinarySearchFunc(public, c.userID, func(e presenceSnapshotEntry, uid int64) int { return cmp.Compare(e.UserID, uid) }); ok && public[i].Status != live[c.userID] {
			own := slices.Clone(public)
			own[i].Status = live[c.userID]
			msg = buildPresenceBatchMsg(own, true)
		}
		c.sendPresenceMsg(msg)
	}
	slog.Debug("hub: presence snapshots sent", "clients", len(stale))
}
