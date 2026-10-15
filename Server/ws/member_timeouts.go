package ws

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// memberTimeoutEntry is one active timeout in the member_timeouts view (WP
// 3C-7c): who, and until when. The reason and the actor never travel here.
type memberTimeoutEntry struct {
	UserID    int64  `json:"user_id"`
	ExpiresAt string `json:"expires_at"`
}

// memberTimeoutsPayload is the member_timeouts frame's payload: targeted,
// unsequenced, never replayed. It REPLACES the viewer's list wholesale, as
// roles_update and emoji_update do.
type memberTimeoutsPayload struct {
	Timeouts []memberTimeoutEntry `json:"timeouts"`
}

func buildMemberTimeouts(entries []memberTimeoutEntry) []byte {
	return buildJSON(wsMsg{Type: MsgTypeMemberTimeouts, Payload: memberTimeoutsPayload{Timeouts: entries}})
}

// memberTimeoutsFor is the one view function behind both ready's
// member_timeouts and the live frame: a moderator (permissions.CanModerate,
// Administrator included) sees every unexpired timeout sorted by user_id;
// anyone else sees only their own entry. Always non-nil, so the wire never
// carries a bare null. An Administrator target is exempt from the effect but
// the ledger row exists, so the view reports it: it shows the sanction that
// was issued.
func memberTimeoutsFor(viewerID int64, isMod bool, active map[int64]time.Time, now time.Time) []memberTimeoutEntry {
	out := make([]memberTimeoutEntry, 0, len(active))
	for uid, until := range active {
		if !now.Before(until) {
			continue
		}
		if !isMod && uid != viewerID {
			continue
		}
		out = append(out, memberTimeoutEntry{UserID: uid, ExpiresAt: until.UTC().Format(time.RFC3339)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UserID < out[j].UserID })
	return out
}

// timeoutViewer is one connected recipient of the member_timeouts view.
type timeoutViewer struct {
	client *Client
	isMod  bool
}

// timeoutViewers maps userIDs to their live clients, each tagged with its
// moderator verdict. Takes h.mu briefly (GetClient) and nothing else, so the
// caller must hold no lock; users with no live client are skipped.
func (h *Hub) timeoutViewers(mods map[int64]bool, extra ...int64) []timeoutViewer {
	ids := make([]int64, 0, len(mods)+len(extra))
	seen := make(map[int64]bool, len(mods)+len(extra))
	for uid := range mods {
		ids = append(ids, uid)
		seen[uid] = true
	}
	for _, uid := range extra {
		if uid != 0 && !seen[uid] {
			seen[uid] = true
			ids = append(ids, uid)
		}
	}
	out := make([]timeoutViewer, 0, len(ids))
	for _, uid := range ids {
		if c := h.GetClient(uid); c != nil {
			out = append(out, timeoutViewer{client: c, isMod: mods[uid]})
		}
	}
	return out
}

// moderatorSet is moderationAudience as a set. Resolves permissions outside
// every lock.
func (h *Hub) moderatorSet(ctx context.Context) map[int64]bool {
	ids := h.moderationAudience(ctx)
	set := make(map[int64]bool, len(ids))
	for _, uid := range ids {
		set[uid] = true
	}
	return set
}

// sendTimeoutViews sends each viewer their own view of snap and records which
// kind of list it holds. The caller holds timeoutViewMu and nothing else.
//
// Lock order: timeoutViewMu, then Client.mu (sendMsg). timeoutViewMu is never
// taken with h.mu, h.seqMu or h.presenceMu held, and nothing under it does
// I/O: sendMsg only queues.
func (h *Hub) sendTimeoutViews(viewers []timeoutViewer, snap map[int64]time.Time, now time.Time) {
	for _, v := range viewers {
		v.client.timeoutsFull.Store(v.isMod)
		v.client.sendMsg(buildMemberTimeouts(memberTimeoutsFor(v.client.userID, v.isMod, snap, now)))
	}
}

// publishMemberTimeouts re-sends the member_timeouts view after targetID's
// timeout was issued, lifted or expired: to every connected moderator (the
// full list) and to targetID (their own entry). It reads the timeout mirror,
// never a parameter, so a stale timer or a superseded issue is harmless.
//
// The visibility watermark is bumped around it, like RefreshUserChannels, so
// a user offline or mid-reconnect resumes onto a full ready (which carries
// member_timeouts) instead of replaying past the change.
//
// The audience is resolved outside every lock. Snapshot and sends then run
// under timeoutViewMu, so the last frame any viewer receives always reflects
// the newest mirror: a concurrent issue and lift cannot leave a moderator
// holding the older list. With the mirror unloaded the publish is skipped
// and logged; the next ready repairs it.
func (h *Hub) publishMemberTimeouts(targetID int64) {
	h.MarkVisibilityChanged()
	defer h.bumpVisibilityWatermark()
	if h.perms == nil {
		return
	}
	ctx := context.Background()
	viewers := h.timeoutViewers(h.moderatorSet(ctx), targetID)
	if len(viewers) == 0 {
		return
	}
	h.timeoutViewMu.Lock()
	defer h.timeoutViewMu.Unlock()
	snap, ok := h.perms.TimeoutSnapshot()
	if !ok {
		slog.Warn("hub: publishMemberTimeouts skipped, timeout mirror not loaded", "user_id", targetID)
		return
	}
	h.sendTimeoutViews(viewers, snap, time.Now())
}

// refreshTimeoutViewsAfterRoleChange runs at the end of
// RefreshAllChannelVisibility. A role edit can make a client a moderator or
// stop it being one: moderators get the full list again, and a client whose
// timeoutsFull flipped true to false gets its own-only list, replacing the
// full one it held. Clients that never were moderators get nothing.
func (h *Hub) refreshTimeoutViewsAfterRoleChange() {
	if h.perms == nil {
		return
	}
	ctx := context.Background()
	mods := h.moderatorSet(ctx)
	h.mu.RLock()
	all := make([]*Client, 0, len(h.clients))
	for _, c := range h.clients {
		all = append(all, c)
	}
	h.mu.RUnlock()

	var viewers []timeoutViewer
	for _, c := range all {
		isMod := mods[c.userID]
		if isMod || c.timeoutsFull.Load() {
			viewers = append(viewers, timeoutViewer{client: c, isMod: isMod})
		}
	}
	if len(viewers) == 0 {
		return
	}
	h.timeoutViewMu.Lock()
	defer h.timeoutViewMu.Unlock()
	snap, ok := h.perms.TimeoutSnapshot()
	if !ok {
		slog.Warn("hub: refreshTimeoutViewsAfterRoleChange skipped, timeout mirror not loaded")
		return
	}
	h.sendTimeoutViews(viewers, snap, time.Now())
}

// readyTimeouts is a ready's member_timeouts slot and which kind it is.
type readyTimeouts struct {
	entries []memberTimeoutEntry
	full    bool
}

// readyMemberTimeouts resolves viewerID's member_timeouts for a fresh ready.
// sub is the viewer's role-only Subject (readReady already holds it). The
// list is read through PermissionService.ActiveTimeouts, which reloads the
// mirror, and fails closed: an error fails that ready like subjectFor does.
// A bare hub without a PermissionService has no mirror and ships [].
func (h *Hub) readyMemberTimeouts(ctx context.Context, viewerID int64, sub permissions.Subject) (readyTimeouts, error) {
	isMod := permissions.CanModerate(sub) == nil
	if h.perms == nil {
		return readyTimeouts{entries: memberTimeoutsFor(viewerID, isMod, nil, time.Now()), full: isMod}, nil
	}
	active, err := h.perms.ActiveTimeouts(ctx)
	if err != nil {
		return readyTimeouts{}, fmt.Errorf("buildReady ActiveTimeouts: %w", err)
	}
	return readyTimeouts{entries: memberTimeoutsFor(viewerID, isMod, active, time.Now()), full: isMod}, nil
}
