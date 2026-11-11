package ws

import (
	"cmp"
	"context"
	"log/slog"
	"maps"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// channel_activity is the unread hint for a readable channel the reader has not
// focused: their chat_message broadcasts never reach them. A hub-owned coalescer
// records each committed non-DM send and a worker flushes on a leading-edge
// window, sending each recipient one frame listing every changed channel.
// The frame goes straight to the recipient's low queue (sendLowMsg): no seq or
// cseq, never replayed or persisted, and a full queue drops it without marking
// loss. ready and mention_count stay authoritative.
// Lock order: activity.mu is a leaf, never taken under seqMu, h.mu, ps.mu or any
// c.mu; flush swaps the map out under mu, releases it, then takes h.mu/ps.mu read
// locks and c.mu one at a time. flushMu serializes flushes and sits above every
// other lock (flush and forget take it, forget before mu), so a purge returns
// only after an in-progress flush finished and cannot send an erased id
// afterwards. note and markRead never take it; no purge entry point holds a hub
// lock calling forget. Nothing here takes seqMu or runs on the dispatch
// goroutine.
const (
	activityWindow       = time.Second
	activityFlushTimeout = 2 * time.Second
	activityMaxMentions  = 16
	// activityReadKeep is how long a read mark can still suppress a hint (a flush
	// resolves within activityFlushTimeout of its take).
	activityReadKeep = 5 * time.Second
)

type readKey struct{ uid, ch int64 }

type readMark struct {
	msgID int64
	at    time.Time
}

type activityNote struct {
	channelID int64
	msgID     int64
	authorID  int64
	mentions  []int64
	roleUsers []int64
	everyone  bool
	hereOnly  bool
	readBy    int64
	// readUpTo and readSet carry the pointer a read mark is set to; readSet false
	// marks through everything noted so far.
	readUpTo int64
	readSet  bool
}

type activityMention struct {
	msgID    int64
	authorID int64
	ids      []int64
	idSet    map[int64]struct{} // built at resolve time, after any forget
	everyone bool
	hereOnly bool
}

type pendingChannel struct {
	latestID       int64
	latestAuthorID int64
	mentions       []activityMention
}

type activityState struct {
	mu        syncutil.Ranked[lockRankLeaf]
	pending   map[int64]*pendingChannel
	lastFlush time.Time
	wake      chan struct{} // cap 1; made on first use so a zero Hub works
	// highest is the highest message id noted per channel; readUpTo is what
	// mark_read and channel_focus read through. Both under mu.
	highest  map[int64]int64
	readUpTo map[readKey]readMark

	flushMu syncutil.Ranked[lockRankSerialiser]
}

func (a *activityState) wakeChan() chan struct{} {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.wake == nil {
		a.wake = make(chan struct{}, 1)
	}
	return a.wake
}

func (a *activityState) note(n activityNote) {
	a.mu.Lock()
	if a.pending == nil {
		a.pending = make(map[int64]*pendingChannel)
	}
	if a.wake == nil {
		a.wake = make(chan struct{}, 1)
	}
	wake := a.wake
	if a.highest == nil {
		a.highest = make(map[int64]int64)
	}
	a.highest[n.channelID] = max(a.highest[n.channelID], n.msgID)
	pc := a.pending[n.channelID]
	if pc == nil {
		pc = &pendingChannel{}
		a.pending[n.channelID] = pc
	}
	if n.msgID > pc.latestID {
		pc.latestID, pc.latestAuthorID = n.msgID, n.authorID
	}
	if len(n.mentions) > 0 || len(n.roleUsers) > 0 || n.everyone {
		pc.mentions = append(pc.mentions, activityMention{
			msgID: n.msgID, authorID: n.authorID, ids: slices.Concat(n.mentions, n.roleUsers),
			everyone: n.everyone, hereOnly: n.hereOnly,
		})
		if len(pc.mentions) > activityMaxMentions {
			oldest := 0
			for i, m := range pc.mentions {
				if m.msgID < pc.mentions[oldest].msgID {
					oldest = i
				}
			}
			pc.mentions = slices.Delete(pc.mentions, oldest, oldest+1)
		}
	}
	a.mu.Unlock()

	select {
	case wake <- struct{}{}:
	default:
	}
}

// markRead records how far uid has read ch; hints at or below it are dropped at
// send time. With set, upTo is the database pointer and may lower the mark
// (mark_unread); without it a focus marks everything noted as read.
func (a *activityState) markRead(uid, ch, upTo int64, set bool, now time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.readUpTo == nil {
		a.readUpTo = make(map[readKey]readMark)
	}
	if !set {
		upTo = a.highest[ch]
	}
	a.readUpTo[readKey{uid, ch}] = readMark{msgID: upTo, at: now}
}

func (a *activityState) readMarks() map[readKey]readMark {
	a.mu.Lock()
	defer a.mu.Unlock()
	return maps.Clone(a.readUpTo)
}

// forget drops pending state naming an erased user or swept message; a frame
// already sent cannot be recalled.
func (a *activityState) forget(userIDs, msgIDs []int64) {
	a.flushMu.Lock()
	defer a.flushMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	for k := range a.readUpTo {
		if slices.Contains(userIDs, k.uid) {
			delete(a.readUpTo, k)
		}
	}
	for chID, pc := range a.pending {
		if slices.Contains(userIDs, pc.latestAuthorID) || slices.Contains(msgIDs, pc.latestID) {
			delete(a.pending, chID)
			continue
		}
		pc.mentions = slices.DeleteFunc(pc.mentions, func(m activityMention) bool {
			return slices.Contains(userIDs, m.authorID) || slices.Contains(msgIDs, m.msgID)
		})
		for i := range pc.mentions {
			pc.mentions[i].ids = slices.DeleteFunc(slices.Clone(pc.mentions[i].ids), func(id int64) bool {
				return slices.Contains(userIDs, id)
			})
		}
	}
}

func (a *activityState) due(now time.Time) (wait time.Duration, pending bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.pending) == 0 {
		return 0, false
	}
	return max(0, activityWindow-now.Sub(a.lastFlush)), true
}

func (a *activityState) take(now time.Time) map[int64]*pendingChannel {
	a.mu.Lock()
	defer a.mu.Unlock()
	batch := a.pending
	if len(batch) == 0 {
		return nil
	}
	a.pending = nil
	a.lastFlush = now
	for k, m := range a.readUpTo {
		if now.Sub(m.at) > activityReadKeep {
			delete(a.readUpTo, k)
		}
	}
	return batch
}

// runChannelActivityLife is a method value, not a closure in Run, so the closures
// Run holds keep their names (api's goleak filter names Run.func1).
func (h *Hub) runChannelActivityLife() { h.runChannelActivity(h.lifeCtx()) }

// runChannelActivity is the coalescer's worker, started once by Run on h.sweeps;
// whatever is pending at exit is discarded (only a hint).
func (h *Hub) runChannelActivity(ctx context.Context) {
	wake := h.activity.wakeChan()
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.stop:
			return
		case <-wake:
		case <-timer.C:
		}
		wait, pending := h.activity.due(time.Now())
		switch {
		case !pending:
			timer.Stop()
		case wait > 0:
			timer.Reset(wait)
		default:
			h.flushChannelActivity(ctx)
		}
	}
}

type channelActivityEntry struct {
	ChannelID        int64  `json:"channel_id"`
	MessageID        int64  `json:"message_id"`
	AuthorID         *int64 `json:"author_id,omitempty"`
	MentionsYou      bool   `json:"mentions_you"`
	MentionsEveryone bool   `json:"mentions_everyone"`
	// forum marks a forum-scoped entry: only a connection that declared forums is
	// sent it.
	forum bool
}

type channelActivityPayload struct {
	Channels []channelActivityEntry `json:"channels"`
}

func (h *Hub) flushChannelActivity(ctx context.Context) {
	a := &h.activity
	a.flushMu.Lock()
	defer a.flushMu.Unlock()

	batch := a.take(time.Now())
	if len(batch) == 0 || h.db == nil || h.readers.Visibility == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, activityFlushTimeout)
	defer cancel()

	perUser := make(map[int64][]channelActivityEntry)
	for _, chID := range slices.Sorted(maps.Keys(batch)) {
		h.resolveChannelActivity(ctx, chID, batch[chID], perUser)
	}
	reads := a.readMarks()
	for _, uid := range slices.Sorted(maps.Keys(perUser)) {
		entries := slices.DeleteFunc(perUser[uid], func(e channelActivityEntry) bool {
			return e.MessageID <= reads[readKey{uid, e.ChannelID}].msgID
		})
		if len(entries) == 0 {
			continue
		}
		// Resolved at send time: a reconnect inside the window gets the frame on
		// its new connection.
		for _, c := range h.clientsOf(uid) {
			shown := entries
			if lacksForums(c) {
				shown = slices.DeleteFunc(slices.Clone(entries), func(e channelActivityEntry) bool { return e.forum })
				if len(shown) == 0 {
					continue
				}
			}
			c.sendLowMsg(buildJSON(wsMsg{
				Type:    MsgTypeChannelActivity,
				Payload: channelActivityPayload{Channels: shown},
			}))
		}
	}
}

// activityReadFailed logs a degraded flush read; the support bundle codes these
// by the shared prefix (admin/support_redaction.go).
func activityReadFailed(what string, attrs ...any) {
	slog.Warn("ws: channel_activity read failed: "+what, attrs...)
}

// resolveChannelActivity appends chID's entries to each recipient's list. A
// failed channel read skips the channel; a failed acknowledgement read treats
// every reader as unacknowledged; a failed blockers read clears that author's
// mention flags.
func (h *Hub) resolveChannelActivity(ctx context.Context, chID int64, pc *pendingChannel, perUser map[int64][]channelActivityEntry) {
	vis := h.readers.Visibility
	ch, err := vis.GetChannel(ctx, chID)
	if err != nil {
		activityReadFailed("GetChannel, skipping channel", "channel_id", chID, "err", err)
		return
	}
	if ch == nil || !carriesChatState(ch.Type) {
		return
	}

	var acked map[int64]bool
	if ch.NSFW {
		acked = activityAcknowledged(ctx, vis, chID)
	}
	mentions, blockers := activityMentions(ctx, vis, pc.mentions)

	focused := make(map[int64]bool)
	for _, c := range h.pubsub.subscribers(ChannelTopic(chID), 0) {
		focused[c.userID] = true
	}

	forumScoped := isForumScoped(ctx, vis, ch) // once per channel, not per recipient
	audience := h.channelReadAudienceFor(ctx, chID, ch, false)
	if ch.IsThread() && !forumScoped { // a forum's posts stay a forum-wide hint
		audience = h.threadFollowersOf(ctx, chID, audience)
	}
	for _, uid := range audience {
		if focused[uid] || uid == pc.latestAuthorID {
			continue
		}
		perUser[uid] = h.activityUserEntries(perUser[uid], uid, chID, pc, mentions, blockers, ch.NSFW && !acked[uid], forumScoped)
	}
}

// threadFollowersOf narrows a thread's audience to its followers; a follow row
// never widens it. No thread service or a failed read sends no thread hint (ready
// is authoritative).
func (h *Hub) threadFollowersOf(ctx context.Context, threadID int64, audience []int64) []int64 {
	svc := h.threadHub.svc
	if svc == nil {
		return nil
	}
	ids, err := svc.Followers(ctx, threadID)
	if err != nil {
		activityReadFailed("Followers, skipping thread", "thread_id", threadID, "err", err)
		return nil
	}
	following := make(map[int64]bool, len(ids))
	for _, id := range ids {
		following[id] = true
	}
	return slices.DeleteFunc(slices.Clone(audience), func(uid int64) bool { return !following[uid] })
}

// activityUserEntries appends uid's entries for one channel to dst: the newest message that
// mentioned them (mentions is newest first), then the latest overall when its id is higher.
func (h *Hub) activityUserEntries(
	dst []channelActivityEntry,
	uid, chID int64, pc *pendingChannel, mentions []activityMention, blockers map[int64]map[int64]bool, withhold, forum bool,
) []channelActivityEntry {
	mentionID, mentioned := int64(0), false
	status, haveStatus := "", false
	for _, m := range mentions {
		if m.authorID == uid || blockers[m.authorID][uid] {
			continue
		}
		if m.everyone && m.hereOnly && !haveStatus {
			status, haveStatus = h.LiveStatus(uid), true
		}
		direct, broad := service.MentionReachSet(m.idSet, m.everyone, m.hereOnly, uid, status)
		if direct || broad {
			e := activityEntry(chID, m.msgID, m.authorID, direct, broad, withhold)
			e.forum = forum
			dst = append(dst, e)
			mentionID, mentioned = m.msgID, true
			break
		}
	}
	if !mentioned || mentionID < pc.latestID {
		e := activityEntry(chID, pc.latestID, pc.latestAuthorID, false, false, withhold)
		e.forum = forum
		dst = append(dst, e)
	}
	return dst
}

func activityAcknowledged(ctx context.Context, vis VisibilityReader, chID int64) map[int64]bool {
	ids, err := vis.ListNSFWAcknowledgedUserIDs(ctx, chID)
	if err != nil {
		activityReadFailed("ListNSFWAcknowledgedUserIDs, withholding authors",
			"channel_id", chID, "err", err)
	}
	acked := make(map[int64]bool, len(ids))
	for _, id := range ids {
		acked[id] = true
	}
	return acked
}

// activityMentions returns the window's mentioning messages, newest first, with
// author blockers; a message whose blockers cannot be read is dropped so it sets
// no mention flag.
func activityMentions(ctx context.Context, vis VisibilityReader, in []activityMention) ([]activityMention, map[int64]map[int64]bool) {
	blockers := make(map[int64]map[int64]bool, len(in))
	out := make([]activityMention, 0, len(in))
	for _, m := range in {
		set, seen := blockers[m.authorID]
		if !seen {
			ids, err := vis.ListBlockersOf(ctx, m.authorID)
			if err != nil {
				activityReadFailed("ListBlockersOf, dropping mention flags",
					"user_id", m.authorID, "err", err)
			} else {
				set = make(map[int64]bool, len(ids))
				for _, id := range ids {
					set[id] = true
				}
			}
			blockers[m.authorID] = set
		}
		if set != nil {
			m.idSet = service.MentionIDSet(m.ids)
			out = append(out, m)
		}
	}
	slices.SortFunc(out, func(x, y activityMention) int { return cmp.Compare(y.msgID, x.msgID) })
	return out, blockers
}

func activityEntry(chID, msgID, authorID int64, direct, broad, withholdAuthor bool) channelActivityEntry {
	e := channelActivityEntry{ChannelID: chID, MessageID: msgID, MentionsYou: direct, MentionsEveryone: broad}
	if !withholdAuthor {
		e.AuthorID = &authorID
	}
	return e
}
