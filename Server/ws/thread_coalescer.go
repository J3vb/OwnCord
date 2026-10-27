package ws

import (
	"context"
	"log/slog"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
)

// threadChangedInterval is the window the thread_changed coalescer holds a
// thread to: at most one frame per thread per window. A var so tests can
// shorten it.
var threadChangedInterval = 2 * time.Second

// threadFlushTimeout bounds one flush's database read.
const threadFlushTimeout = 5 * time.Second

// threadNote tells the hub a thread changed (deleted false), or is gone.
type threadNote struct {
	threadID int64
	parentID int64 // set on a delete, for the frame to the sockets that had it open
	deleted  bool
}

// ThreadNoteEvent feeds the thread_changed coalescer. It is deliberately not a
// ChannelEvent: nothing is sequenced when it is emitted, the coalescer
// sequences the frame when it flushes.
type ThreadNoteEvent interface {
	Event
	ThreadNote() threadNote
}

// threadNoteEvt is a committed thread change (create, rename, archive, lock,
// a message) or a delete.
type threadNoteEvt struct {
	threadID int64
	parentID int64
	deleted  bool
}

func (e threadNoteEvt) EventType() string            { return MsgTypeThreadChanged }
func (e threadNoteEvt) ThreadNote() threadNote       { return threadNote(e) }
func (e threadNoteEvt) deliveryClass() deliveryClass { return classThreadNote }

// threadTimer is one thread's coalescing state. window is true once the
// leading frame went out, so the timer's next firing closes the window rather
// than opening it; pending is a change that arrived since the last flush.
type threadTimer struct {
	t       *time.Timer
	window  bool
	pending bool
}

// threadHub is the hub's thread state: the thread service the coalescer reads
// through, and one timer per thread with a window open. The map is guarded by
// Hub.mu and holds only threads with a recent change, so it is bounded by the
// number of threads active in the last window.
type threadHub struct {
	svc     *service.ThreadService
	timers  map[int64]*threadTimer
	stopped bool
}

// ThreadChanged implements service.ThreadNotifier: the archiver reports an
// archived thread here.
func (h *Hub) ThreadChanged(threadID int64) { h.noteThreadChanged(threadID) }

// noteThreadChanged records that thread threadID changed. The first change
// after a quiet period flushes at once (the leading edge), later ones inside
// the window are folded into one trailing flush when it closes. The frame
// carries absolute values, so folding loses nothing.
func (h *Hub) noteThreadChanged(threadID int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	th := &h.threadHub
	if th.stopped || th.svc == nil {
		return
	}
	if e, ok := th.timers[threadID]; ok {
		e.pending = true
		return
	}
	if th.timers == nil {
		th.timers = make(map[int64]*threadTimer)
	}
	e := &threadTimer{}
	th.timers[threadID] = e
	e.t = time.AfterFunc(0, func() { h.fireThreadTimer(threadID, e) })
}

// fireThreadTimer runs when a thread's timer fires: the leading flush, or the
// end of a window. It does nothing once the hub's lifecycle ended or the entry
// was dropped (a delete, a stop).
func (h *Hub) fireThreadTimer(threadID int64, e *threadTimer) {
	if h.life.Err() != nil {
		return
	}
	h.mu.Lock()
	th := &h.threadHub
	if th.stopped || th.timers[threadID] != e {
		h.mu.Unlock()
		return
	}
	if e.window && !e.pending {
		delete(th.timers, threadID)
		h.mu.Unlock()
		return
	}
	e.window, e.pending = true, false
	h.mu.Unlock()

	h.flushThreadChanged(threadID, e)

	h.mu.Lock()
	if !th.stopped && th.timers[threadID] == e {
		e.t.Reset(threadChangedInterval)
	}
	h.mu.Unlock()
}

// flushThreadChanged reads the thread's current state and sequences a
// thread_changed on its parent. The read is not atomic with the broadcast, so
// a delete can land in between: the frame is dropped unless e is still the
// thread's live timer entry (a delete removes it, forgetThread, before it
// announces thread_deleted), so no thread_changed follows a thread_deleted.
func (h *Hub) flushThreadChanged(threadID int64, e *threadTimer) {
	ctx, cancel := context.WithTimeout(h.life, threadFlushTimeout)
	defer cancel()
	t, err := h.threadHub.svc.Get(ctx, threadID)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("ws: thread_changed read failed, dropping frame", "thread_id", threadID, "err", err)
		}
		return
	}
	if t == nil {
		return
	}
	h.mu.RLock()
	live := !h.threadHub.stopped && h.threadHub.timers[threadID] == e
	h.mu.RUnlock()
	if !live {
		return
	}
	h.broadcastChannelEvent(ctx, 0, channelEvt{
		evType: MsgTypeThreadChanged, channelID: t.ParentID, payload: buildThreadChanged(t),
	})
	h.sendThreadFollowUpdates(ctx, t, e)
}

// threadFollowBeforeSendHook, when non-nil, runs in sendThreadFollowUpdates
// after the audience is resolved and before the final live check, so a test can
// land an unfollow or a delete in exactly that window.
var threadFollowBeforeSendHook func()

// sendThreadFollowUpdates tells each connected follower of t that they follow
// it, with its current state, so a rename, archive, lock or new message reaches
// the sidebar row of a client that did not hear thread_changed (its parent is
// not the focused channel), and a user a post just made a follower hears it
// from the flush that post raised. A follower is only a candidate: it must also
// be in the parent's read audience (and have acknowledged an NSFW parent), so a
// user who lost the parent hears nothing and the follow row stays for when they
// regain it. The audience read is not atomic with the send, so the entry is
// checked live and the followers read again after it: an unfollow or a delete
// that committed meanwhile has already sent its own following:false, and this
// frame must not follow it. A failed read drops the frames, since ready is
// authoritative.
func (h *Hub) sendThreadFollowUpdates(ctx context.Context, t *service.ThreadInfo, e *threadTimer) {
	audience, forumScoped := h.threadFollowAudience(ctx, t)
	if len(audience) == 0 {
		return
	}
	if threadFollowBeforeSendHook != nil {
		threadFollowBeforeSendHook()
	}
	h.mu.RLock()
	live := !h.threadHub.stopped && h.threadHub.timers[t.ID] == e
	h.mu.RUnlock()
	if !live {
		return
	}
	now, err := h.threadHub.svc.Followers(ctx, t.ID)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("ws: thread follow read failed, dropping follow updates", "thread_id", t.ID, "err", err)
		}
		return
	}
	payload := buildThreadFollowUpdate(t.ID, true, t)
	for _, uid := range now {
		if !slices.Contains(audience, uid) {
			continue
		}
		if !forumScoped {
			h.SendToUserLow(uid, payload)
			continue
		}
		// A forum's posts go only to a connection that declared forums.
		for _, c := range h.clientsOf(uid) {
			if !lacksForums(c) {
				c.sendLowMsg(payload)
			}
		}
	}
}

// threadFollowAudience is the connected followers of t who may read it: the
// followers intersected with the parent's read audience and, for an NSFW
// parent, with the users who acknowledged it (one batch read, as
// resolveChannelActivity does). A failed read yields nobody. forumScoped
// reports a forum's post, whose frames go only to connections that declared
// forums.
func (h *Hub) threadFollowAudience(ctx context.Context, t *service.ThreadInfo) ([]int64, bool) {
	vis := h.readers.Visibility
	if vis == nil {
		return nil, false
	}
	followers, err := h.threadHub.svc.Followers(ctx, t.ID)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("ws: thread follow read failed, dropping follow updates", "thread_id", t.ID, "err", err)
		}
		return nil, false
	}
	if len(followers) == 0 {
		return nil, false
	}
	ch, err := vis.GetChannel(ctx, t.ID)
	if err != nil || ch == nil {
		return nil, false
	}
	var acked map[int64]bool
	if ch.NSFW {
		acked = activityAcknowledged(ctx, vis, ch.Thread.ParentID)
	}
	forumScoped := isForumScoped(ctx, vis, ch) // a forum's posts go only to clients that know forums
	var out []int64
	for _, uid := range h.channelReadAudienceFor(ctx, t.ID, ch, false) {
		if slices.Contains(followers, uid) && (!ch.NSFW || acked[uid]) {
			out = append(out, uid)
		}
	}
	return out, forumScoped
}

// forgetThread drops a deleted thread's coalescing state, so no timer fires a
// frame for a thread that no longer exists.
func (h *Hub) forgetThread(threadID int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if e, ok := h.threadHub.timers[threadID]; ok {
		e.t.Stop()
		delete(h.threadHub.timers, threadID)
	}
}

// stopThreadFeed cancels every pending timer and refuses new ones. closeStop
// calls it, so no thread timer outlives the hub.
func (h *Hub) stopThreadFeed() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.threadHub.stopped = true
	for id, e := range h.threadHub.timers {
		e.t.Stop()
		delete(h.threadHub.timers, id)
	}
}

// handleThreadNote applies a ThreadNoteEvent: a change feeds the coalescer, a
// delete drops the thread's state and releases every socket that had it open.
func (h *Hub) handleThreadNote(n threadNote) {
	if !n.deleted {
		h.noteThreadChanged(n.threadID)
		return
	}
	h.forgetThread(n.threadID)
	h.releaseThreadSockets(n.threadID, n.parentID)
}

// noteIfThread feeds the coalescer when channelID is a thread, for the paths
// that change a thread's messages without a handler result (a bulk delete or a
// purge). An ordinary channel costs one lookup and nothing more.
func (h *Hub) noteIfThread(channelID int64) {
	svc := h.threadHub.svc
	if svc == nil {
		return
	}
	ctx, cancel := context.WithTimeout(h.life, threadFlushTimeout)
	defer cancel()
	if t, err := svc.Get(ctx, channelID); err == nil && t != nil {
		h.noteThreadChanged(channelID)
	}
}
