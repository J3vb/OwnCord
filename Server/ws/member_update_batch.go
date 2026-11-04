package ws

import (
	"context"
	"slices"
	"time"
)

// sendMemberUpdates sends every listed user's role, connected or not, as one
// member_update_batch per memberUpdateBatch members (a lone member gets a plain
// member_update, which every client version understands). Each frame waits for
// dispatch to catch up and then pauses, so a role with thousands of holders does not
// flood the queue. A refused enqueue waits for dispatch and retries once; the drop is
// already recorded as a loss for resumers.
func (h *Hub) sendMemberUpdates(ctx context.Context, ids []int64) {
	chunk := make([]memberUpdatePayload, 0, min(len(ids), memberUpdateBatch))
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
		chunk = append(chunk, memberUpdatePayload{UserID: uid, Role: name, RoleIDs: roleIDs})
		if len(chunk) < memberUpdateBatch {
			continue
		}
		h.enqueueMemberUpdates(ctx, chunk)
		chunk = chunk[:0]
		select {
		case <-ctx.Done():
			return
		case <-time.After(memberUpdatePause):
		}
	}
	if len(chunk) > 0 {
		h.enqueueMemberUpdates(ctx, chunk)
	}
}

// memberUpdatesMsg is a plain member_update for one member, a member_update_batch
// for several, nil for none.
func memberUpdatesMsg(members []memberUpdatePayload) []byte {
	switch len(members) {
	case 0:
		return nil
	case 1:
		m := members[0]
		return buildMemberUpdate(m.UserID, m.Role, m.RoleIDs)
	default:
		return buildMemberUpdateBatch(members)
	}
}

// memberUpdatesWithoutErased returns msg, or when a member was erased after the
// round read it, the frame rebuilt without that member (nil when none is left).
// Called under seqMu, which guards the tombstones.
func (h *Hub) memberUpdatesWithoutErased(members []memberUpdatePayload, msg []byte) []byte {
	if len(h.tombstones.users) == 0 {
		return msg
	}
	kept := members[:0:0]
	for _, m := range members {
		if !h.tombstones.erased(m.UserID) {
			kept = append(kept, m)
		}
	}
	if len(kept) == len(members) {
		return msg
	}
	return memberUpdatesMsg(kept)
}

// enqueueMemberUpdates enqueues one global frame for members and waits for dispatch.
func (h *Hub) enqueueMemberUpdates(ctx context.Context, members []memberUpdatePayload) {
	bm := broadcastMsg{channelID: 0, msg: memberUpdatesMsg(members), members: slices.Clone(members)}
	if !h.enqueue(bm, "member_update") {
		_ = h.awaitDispatch(ctx)
		h.enqueue(bm, "member_update")
	}
	_ = h.awaitDispatch(ctx)
}
