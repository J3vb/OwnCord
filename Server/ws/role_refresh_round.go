package ws

import (
	"context"
	"log/slog"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// Round tuning. Vars so tests can shrink them.
var (
	// roleRefreshUserBudget bounds one user's permission resolution.
	roleRefreshUserBudget = 5 * time.Second
	// roleRefreshListBudget bounds the once-per-round channel list.
	roleRefreshListBudget = 5 * time.Second
	// roleRefreshChunk is how many sidebar frames go to a client before the
	// worker waits for its queue to drain.
	roleRefreshChunk = 64
	// roleRefreshDrainWait is how long the worker waits for a client's queue
	// to fall to its threshold (room for two chunks before the first chunk,
	// a quarter of its capacity between chunks) before kicking it.
	roleRefreshDrainWait = 500 * time.Millisecond
	// memberUpdateBatch is how many member_update frames are enqueued before
	// the worker waits for dispatch to catch up, then pauses memberUpdatePause.
	memberUpdateBatch = 64
	// roleRefreshListAttempts is how many consecutive rounds may fail to read
	// the channel list before the affected users are closed.
	roleRefreshListAttempts = 3
	// roleRefreshRetryBackoff is the wait before a round that could not read
	// the channel list runs again.
	roleRefreshRetryBackoff = 500 * time.Millisecond
	// memberUpdatePause is the breathing space between member_update batches.
	memberUpdatePause = 5 * time.Millisecond
)

// roleFrame is one sidebar frame for a user: a channel_create, or (remove) a
// channel_delete.
type roleFrame struct {
	channelID int64
	remove    bool
	msg       []byte
	// chType is the channel's type, for a create frame: the client features
	// are checked against it when the frame is sent (sendRoleRefreshFrames).
	chType string
}

// roleChannels is a round's channel snapshot.
type roleChannels struct {
	servers []roleChannel
	dms     map[int64]struct{} // DM ids: a role change never revokes these
	known   map[int64]struct{} // every channel id in the snapshot
}

// runRoleRound is one round: sidebar and topics for the Visibility users, a
// paced member_update per MemberUpdate user, the timeout views of the users
// whose role changed, then one roles_update. When the channel list cannot be
// read it puts the whole batch back and returns the backoff before the next
// attempt; after roleRefreshListAttempts consecutive failures the users are
// closed instead (they reconnect onto a full ready) and the round goes on.
func (h *Hub) runRoleRound(ctx context.Context, b roleBatch) time.Duration {
	s := &h.roleRefresh
	vis := b.usersWith(rrVisibility)
	if len(vis) > 0 || b.all {
		ids := vis
		if b.all {
			ids = h.connectedUserIDs()
		}
		h.beginVisibilityRefresh()
		if h.db != nil && len(ids) > 0 {
			rc, ok := h.listRoleChannels(ctx)
			switch {
			case ok:
				s.listFailures = 0
				h.refreshUsersWith(ctx, ids, s.done, rc)
			case ctx.Err() != nil:
				return 0
			default:
				s.listFailures++
				if s.listFailures < roleRefreshListAttempts {
					slog.Warn("hub: role refresh could not list channels, retrying",
						"attempt", s.listFailures)
					s.requeue(b)
					return roleRefreshRetryBackoff
				}
				s.listFailures = 0
				h.closeUsers(ids, s.done)
			}
		}
		if ctx.Err() != nil {
			return 0
		}
		var only map[int64]struct{}
		if !b.all {
			only = make(map[int64]struct{}, len(vis))
			for _, uid := range vis {
				only[uid] = struct{}{}
			}
		}
		h.refreshTimeoutViewsFor(ctx, only)
	}
	h.sendMemberUpdates(ctx, b.usersWith(rrMember))
	if b.roles && ctx.Err() == nil {
		h.broadcastRolesNow(ctx)
	}
	return 0
}

// connectedUserIDs is a snapshot of the connected users.
func (h *Hub) connectedUserIDs() []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.connectedUserIDsLocked()
}

// beginVisibilityRefresh marks the start of a visibility refresh: it bumps
// timeoutView.gen first (the 3C-7c contract: the caller invalidated, then this
// bump, so a publish that resolved earlier resolves again), and moves the
// watermark before the slow part so a reconnect handshake's re-check sees this
// change (OC-0206).
func (h *Hub) beginVisibilityRefresh() {
	h.bumpTimeoutViewGen()
	h.bumpVisibilityWatermark()
}

// refreshVisibilityUsers is the synchronous refresh of ids: it reads the
// channel list once and runs refreshUserVisibility per user. A list that
// cannot be read closes each user's socket. done, when set, is called after
// each user's step.
func (h *Hub) refreshVisibilityUsers(ctx context.Context, ids []int64, done func(int64)) {
	h.beginVisibilityRefresh()
	if h.db == nil || len(ids) == 0 {
		return
	}
	rc, ok := h.listRoleChannels(ctx)
	if !ok {
		h.closeUsers(ids, done)
		return
	}
	h.refreshUsersWith(ctx, ids, done, rc)
}

// closeUsers closes ids' sockets (never BANNED); each reconnects onto a full
// ready built from committed state.
func (h *Hub) closeUsers(ids []int64, done func(int64)) {
	for _, uid := range ids {
		for _, c := range h.clientsOf(uid) {
			h.kickClient(c)
		}
		h.bumpVisibilityWatermark()
		if done != nil {
			done(uid)
		}
	}
}

// userSend is one user's sidebar frames, prepared by the first pass.
type userSend struct {
	uid    int64
	frames []roleFrame
}

// refreshUsersWith refreshes ids over the round's channel snapshot in two
// passes. The first resolves every user's verdicts and releases their held
// topics, so a user's revocation never waits behind another user's sends or
// drain waits. The second sends each user's frames, then moves the watermark,
// then stops covering the user: a reconnect that finds the user settled also
// finds a watermark at or above every seq that client could have acknowledged,
// and the targeted frames sit in the normal FIFO ahead of any later seq.
func (h *Hub) refreshUsersWith(ctx context.Context, ids []int64, done func(int64), rc *roleChannels) {
	settle := func(uid int64) {
		h.bumpVisibilityWatermark()
		if done != nil {
			done(uid)
		}
	}
	sends := make([]userSend, 0, len(ids))
	for _, uid := range ids {
		if ctx.Err() != nil {
			return
		}
		frames, ok := h.prepareUserVisibility(ctx, uid, rc)
		if !ok {
			settle(uid)
			continue
		}
		sends = append(sends, userSend{uid: uid, frames: frames})
	}
	for _, us := range sends {
		if ctx.Err() != nil {
			return
		}
		if g := h.roleRefresh.sendGate.Load(); g != nil {
			(*g)(us.uid)
		}
		h.sendRoleRefreshFrames(ctx, us.uid, us.frames)
		settle(us.uid)
	}
}

// listRoleChannels reads the channel list and each server channel's private
// flag once for the round. A failed list reports false.
func (h *Hub) listRoleChannels(ctx context.Context) (*roleChannels, bool) {
	ctx, cancel := context.WithTimeout(ctx, roleRefreshListBudget)
	defer cancel()
	channels, err := h.readers.Visibility.ListChannels(ctx)
	if err != nil {
		slog.Warn("hub: RefreshAllChannelVisibility could not list channels", "err", err)
		return nil, false
	}
	rc := &roleChannels{known: make(map[int64]struct{}, len(channels)), dms: make(map[int64]struct{})}
	for i := range channels {
		if channels[i].IsThread() {
			// A thread has no sidebar entry and no verdict of its own: the
			// verdict loop settles the one a socket holds from its parent's.
			continue
		}
		rc.known[channels[i].ID] = struct{}{}
		if channels[i].Type == "dm" {
			rc.dms[channels[i].ID] = struct{}{}
			continue
		}
		rc.servers = append(rc.servers, roleChannel{
			ch:      &channels[i],
			private: h.channelIsPrivate(ctx, channels[i].ID, channels[i].Type),
		})
	}
	return rc, true
}

// prepareUserVisibility is a user's first-pass step: resolve their verdicts and
// release their held topics, so the content they lost access to stops before
// anything is sent. It returns the sidebar frames to send, and false when
// there is nothing to send: the user is not connected, was closed because their
// permissions could not be resolved (never sent BANNED; they reconnect onto a
// full ready), or went away during the step.
func (h *Hub) prepareUserVisibility(ctx context.Context, uid int64, rc *roleChannels) ([]roleFrame, bool) {
	if conns := h.clientsOf(uid); len(conns) == 0 || conns[0].user == nil {
		return nil, false
	}
	frames, allowed, ok := h.roleRefreshVerdicts(ctx, uid, rc)
	if !ok {
		if conns := h.clientsOf(uid); len(conns) > 0 && ctx.Err() == nil {
			slog.Warn("hub: role refresh could not resolve permissions, closing socket", "user_id", uid)
			for _, c := range conns {
				h.kickClient(c)
			}
		}
		return nil, false
	}
	rctx, cancel := context.WithTimeout(ctx, roleRefreshUserBudget)
	revoked, live := h.revokeTopicsNotIn(rctx, uid, allowed, rc.known)
	cancel()
	if !live {
		return nil, false
	}
	if g := h.roleRefresh.userGate.Load(); g != nil {
		(*g)(uid)
	}
	// The revocation already told the client to drop these; do not repeat it.
	frames = slices.DeleteFunc(frames, func(f roleFrame) bool {
		_, done := revoked[f.channelID]
		return done && f.remove
	})
	return frames, true
}

// heldDMs is the DMs uid holds a topic on, all allowed: a role change never
// revokes a DM. Only held DMs matter, so the cost follows the user's
// subscriptions rather than every DM on the server.
func (h *Hub) heldDMs(uid int64, rc *roleChannels) map[int64]bool {
	allowed := make(map[int64]bool, len(rc.servers))
	for _, topic := range h.topicsOfUser(uid) {
		if id := channelTopicID(topic); id != 0 {
			if _, dm := rc.dms[id]; dm {
				allowed[id] = true
			}
		}
	}
	return allowed
}

// roleRefreshVerdicts resolves uid's subject once per server channel, through
// the permission cache. It returns the frame to send for each channel (a
// channel_create with this user's affordances, or a channel_delete) and the
// set of channels the user may keep a topic on: the visible ones plus every
// DM the user holds, which a role change never revokes.
func (h *Hub) roleRefreshVerdicts(ctx context.Context, uid int64, rc *roleChannels) (frames []roleFrame, allowed map[int64]bool, ok bool) {
	ctx, cancel := context.WithTimeout(ctx, roleRefreshUserBudget)
	defer cancel()
	allowed = h.heldDMs(uid, rc)
	frames = make([]roleFrame, 0, len(rc.servers))
	for _, e := range rc.servers {
		sub, err := h.subjectFor(ctx, uid, e.ch.ID)
		if err != nil {
			return nil, nil, false
		}
		sub.Channel = channelRef(e.ch)
		if permissions.CanViewChannel(sub) != nil {
			frames = append(frames, roleFrame{channelID: e.ch.ID, remove: true, msg: buildChannelDelete(e.ch.ID)})
			continue
		}
		allowed[e.ch.ID] = true
		frames = append(frames, roleFrame{channelID: e.ch.ID, chType: e.ch.Type, msg: buildChannelCreateFor(e.ch, e.private, affordancesFor(sub))})
	}
	// A channel created after the snapshot and held by this user is resolved
	// now, so it is kept and sent when the user may view it.
	for _, topic := range h.topicsOfUser(uid) {
		chID := channelTopicID(topic)
		if _, in := rc.known[chID]; chID == 0 || in {
			continue
		}
		ch, err := h.readers.Visibility.GetChannel(ctx, chID)
		if err != nil {
			return nil, nil, false
		}
		if ch == nil {
			allowed[chID] = false
			continue
		}
		if ch.Type == "dm" {
			allowed[chID] = true
			continue
		}
		if ch.IsThread() {
			// A held thread topic follows its parent's verdict and gets no
			// sidebar frame: threads are never channel_create'd.
			v, err := h.roleThreadVerdict(ctx, uid, ch, allowed)
			if err != nil {
				return nil, nil, false
			}
			allowed[chID] = v
			continue
		}
		sub, err := h.subjectFor(ctx, uid, chID)
		if err != nil {
			return nil, nil, false
		}
		sub.Channel = channelRef(ch)
		if permissions.CanViewChannel(sub) != nil {
			allowed[chID] = false
			continue
		}
		allowed[chID] = true
		frames = append(frames, roleFrame{channelID: chID, chType: ch.Type, msg: buildChannelCreateFor(ch, h.channelIsPrivate(ctx, chID, ch.Type), affordancesFor(sub))})
	}
	return frames, allowed, true
}

// sendRoleRefreshFrames queues frames in chunks to each of uid's live
// connections, waiting between chunks for its queue to drain. A client that
// does not drain in time is kicked, never sent BANNED, and converges on a full
// ready; the user's other devices are unaffected.
func (h *Hub) sendRoleRefreshFrames(ctx context.Context, uid int64, frames []roleFrame) {
	for _, snap := range h.clientsOf(uid) {
		h.sendRoleRefreshFramesTo(ctx, snap, frames)
	}
}

// sendRoleRefreshFramesTo is sendRoleRefreshFrames for one device, identified
// by the session of snap; a same-session reconnect during the round is followed
// to its replacement.
func (h *Hub) sendRoleRefreshFramesTo(ctx context.Context, snap *Client, frames []roleFrame) {
	for start := 0; start < len(frames); start += roleRefreshChunk {
		live := h.sessionClient(snap.userID, snap.tokenHash)
		if live == nil {
			return
		}
		// The first chunk needs room for itself plus a chunk's worth of
		// frames from concurrent dispatch; later chunks wait for the queue
		// to fall to a quarter of its capacity.
		limit := sendBufSize / 4
		if start == 0 {
			limit = sendBufSize - 2*roleRefreshChunk
		}
		if !waitSendDrain(ctx, live, limit) {
			if ctx.Err() == nil {
				h.kickClient(live)
			}
			return
		}
		for _, f := range frames[start:min(start+roleRefreshChunk, len(frames))] {
			// A socket without the forums feature is sent no forum row (see
			// client_features.go). The client is read here, at send time and
			// from the same value that gets the frame: a reconnect during the
			// round's lookups replaced it with one that made its own declaration.
			if !f.remove && !live.features.allowsType(f.chType) {
				continue
			}
			live.sendMsg(f.msg)
		}
	}
}

// waitSendDrain waits until c's normal queue holds at most limit frames, for at most roleRefreshDrainWait. It reports whether it drained.
func waitSendDrain(ctx context.Context, c *Client, limit int) bool {
	if len(c.send) <= limit {
		return true
	}
	deadline := time.NewTimer(roleRefreshDrainWait)
	defer deadline.Stop()
	tick := time.NewTicker(2 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-deadline.C:
			return len(c.send) <= limit
		case <-tick.C:
			if len(c.send) <= limit {
				return true
			}
		}
	}
}

// roleNameNow reads uid's current role name at send time, so a coalesced or
// overtaken enqueue announces the committed name.
func (h *Hub) roleNameNow(ctx context.Context, uid int64) (name string, roleIDs []int64, ok bool) {
	var err error
	found := false
	switch {
	case h.perms != nil:
		role, rerr := h.perms.GetRoleForUser(ctx, uid)
		err = rerr
		if role != nil {
			name, roleIDs, found = role.Top.Name, role.IDs, true
		}
	case h.readers.Members != nil:
		role, rerr := h.readers.Members.GetMemberRoles(ctx, uid)
		err = rerr
		if role != nil {
			name, roleIDs, found = role.Top.Name, role.IDs, true
		}
	}
	if err != nil || !found {
		slog.Warn("hub: role refresh member_update skipped, role unreadable", "user_id", uid, "err", err)
		return "", nil, false
	}
	return name, slices.Clone(roleIDs), true
}

// sendMemberUpdates enqueues one member_update per user, connected or not, in
// batches. Each batch waits for dispatch to catch up and then pauses, so a role
// with thousands of holders does not flood the dispatch queue. An enqueue that
// is refused waits for dispatch and tries once more; the drop is already
// recorded as a loss for resumers.
func (h *Hub) sendMemberUpdates(ctx context.Context, ids []int64) {
	sent := 0
	for _, uid := range ids {
		if ctx.Err() != nil {
			return
		}
		rctx, cancel := context.WithTimeout(ctx, roleRefreshUserBudget)
		name, roleIDs, ok := h.roleNameNow(rctx, uid)
		cancel()
		if !ok {
			continue
		}
		bm := broadcastMsg{channelID: 0, msg: buildMemberUpdate(uid, name, roleIDs)}
		if !h.enqueue(bm, "member_update") {
			_ = h.awaitDispatch(ctx)
			h.enqueue(bm, "member_update")
		}
		sent++
		if sent%memberUpdateBatch == 0 {
			_ = h.awaitDispatch(ctx)
			select {
			case <-ctx.Done():
				return
			case <-time.After(memberUpdatePause):
			}
		}
	}
}

// broadcastRolesNow re-reads the role list and pushes it to every client. One
// goroutine does the read and the enqueue, so lists go out in commit order.
func (h *Hub) broadcastRolesNow(ctx context.Context) {
	if h.readers.Ready == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, roleRefreshListBudget)
	defer cancel()
	roles, err := h.readers.Ready.ListRoles(ctx)
	if err != nil {
		// The mutation already committed; clients converge on their next
		// reconnect rather than seeing a failed request.
		slog.Warn("hub: role refresh roles_update skipped, role list unreadable", "err", err)
		return
	}
	h.BroadcastRolesUpdate(roles)
}
