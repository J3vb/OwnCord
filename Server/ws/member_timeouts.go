package ws

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// memberTimeoutEntry is one active timeout in the member_timeouts view; the reason and actor never travel
// here.
type memberTimeoutEntry struct {
	UserID    int64  `json:"user_id"`
	ExpiresAt string `json:"expires_at"`
}

// memberTimeoutsPayload is the member_timeouts payload: targeted, unsequenced, never replayed; it REPLACES
// the viewer's list wholesale.
type memberTimeoutsPayload struct {
	Timeouts []memberTimeoutEntry `json:"timeouts"`
}

func buildMemberTimeouts(entries []memberTimeoutEntry) []byte {
	return buildJSON(wsMsg{Type: MsgTypeMemberTimeouts, Payload: memberTimeoutsPayload{Timeouts: entries}})
}

// memberTimeoutsFor is the one view function behind ready's member_timeouts and the live
// frame: a moderator (permissions.CanModerate, Administrator included) sees every
// unexpired timeout sorted by user_id; anyone else only their own. Always non-nil, so the
// wire never carries a bare null. An Administrator target is exempt from the effect but the
// ledger row exists, so the view reports the issued sanction.
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

// publishMemberTimeouts re-sends the member_timeouts view after targetID's timeout was
// issued, lifted or expired: to every connected moderator (full list) and to targetID (own
// entry). It reads the timeout mirror, never a parameter, so a stale timer or superseded
// issue is harmless. The frames are unsequenced, so the fan-out is bracketed by
// begin/endTargetedFanout: an offline or mid-reconnect user resumes onto a full ready
// instead of replaying past the change. deliverTimeoutViews resolves the audience outside
// every lock and again if a role refresh started; snapshot and sends run under
// timeoutView.mu, so a concurrent issue and lift cannot leave a viewer with the older
// mirror. A verdict made stale by a role change whose refresh has not started is corrected
// by that refresh (the flag records which list each client holds). An unloaded mirror is
// reloaded once; if that fails the publish is skipped and logged, and the next ready repairs it.
func (h *Hub) publishMemberTimeouts(targetID int64) {
	h.beginTargetedFanout()
	defer h.endTargetedFanout()
	if h.perms == nil {
		return
	}
	ok := h.deliverTimeoutViews(context.Background(), nil, func(c *Client, isMod bool) bool {
		return isMod || c.userID == targetID
	})
	if !ok {
		slog.Warn("hub: publishMemberTimeouts skipped, timeout mirror not loaded", "user_id", targetID)
	}
}

// refreshTimeoutViewsAfterRoleChange runs at the end of a role refresh, after the caller
// invalidated the permission cache. A role edit can make a client a moderator or not:
// moderators get the full list again; a client holding the full list that is no longer a
// moderator gets its own-only list; own-only holders who stay non-moderators get nothing.
// only restricts the pass to role-changed users (nil: all connected). refreshVisibilityUsers
// bumps timeoutView.gen on entry so an earlier publish resolves again; begin/endTargetedFanout
// force a resume across it onto a full ready.
func (h *Hub) refreshTimeoutViewsAfterRoleChange() {
	h.refreshTimeoutViewsFor(context.Background(), nil)
}

// refreshTimeoutViewsFor is refreshTimeoutViewsAfterRoleChange over only (nil: every connected user), against
// ctx.
func (h *Hub) refreshTimeoutViewsFor(ctx context.Context, only map[int64]struct{}) {
	if h.perms == nil {
		return
	}
	h.beginTargetedFanout()
	defer h.endTargetedFanout()
	ok := h.deliverTimeoutViews(ctx, only, func(c *Client, isMod bool) bool {
		return isMod || c.timeouts.full.Load()
	})
	if !ok {
		slog.Warn("hub: refreshTimeoutViewsAfterRoleChange skipped, timeout mirror not loaded")
	}
}

type readyTimeouts struct {
	entries []memberTimeoutEntry
	full    bool
}

// readyMemberTimeouts resolves viewerID's member_timeouts for a fresh ready. sub is the
// viewer's role-only Subject. The list is read through PermissionService.ActiveTimeouts
// (reloads the mirror) and fails closed: an error fails that ready. A bare hub without a
// PermissionService ships [].
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
