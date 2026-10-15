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

// publishMemberTimeouts re-sends the member_timeouts view after targetID's
// timeout was issued, lifted or expired: to every connected moderator (the
// full list) and to targetID (their own entry). It reads the timeout mirror,
// never a parameter, so a stale timer or a superseded issue is harmless.
//
// The visibility watermark is bumped around it, like RefreshUserChannels, so
// a user offline or mid-reconnect resumes onto a full ready (which carries
// member_timeouts) instead of replaying past the change.
//
// deliverTimeoutViews resolves the audience outside every lock and re-checks
// it against concurrent role refreshes; snapshot and sends then run under
// timeoutView.mu, so the last frame any viewer receives always reflects the
// newest mirror and a current verdict. With the mirror unloaded the publish
// is skipped and logged; the next ready repairs it.
func (h *Hub) publishMemberTimeouts(targetID int64) {
	h.MarkVisibilityChanged()
	defer h.bumpVisibilityWatermark()
	if h.perms == nil {
		return
	}
	ok := h.deliverTimeoutViews(context.Background(), func(c *Client, isMod bool) bool {
		return isMod || c.userID == targetID
	})
	if !ok {
		slog.Warn("hub: publishMemberTimeouts skipped, timeout mirror not loaded", "user_id", targetID)
	}
}

// refreshTimeoutViewsAfterRoleChange runs at the end of every
// RefreshAllChannelVisibility, after the caller invalidated the permission
// cache. A role edit can make a client a moderator or stop it being one:
// moderators get the full list again, and a client that holds the full list
// but is no longer a moderator gets its own-only list, replacing it. Clients
// holding their own-only list that stay non-moderators get nothing.
//
// It bumps timeoutView.gen first, so a publish or connect that resolved its
// verdicts before this role change resolves them again, and the visibility
// watermark, so a resume across it takes a full ready.
func (h *Hub) refreshTimeoutViewsAfterRoleChange() {
	if h.perms == nil {
		return
	}
	h.bumpTimeoutViewGen()
	h.MarkVisibilityChanged()
	defer h.bumpVisibilityWatermark()
	ok := h.deliverTimeoutViews(context.Background(), func(c *Client, isMod bool) bool {
		return isMod || c.timeouts.full.Load()
	})
	if !ok {
		slog.Warn("hub: refreshTimeoutViewsAfterRoleChange skipped, timeout mirror not loaded")
	}
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
