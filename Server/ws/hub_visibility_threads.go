package ws

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// The thread half of channel visibility. A thread has no permission state of its own, so a socket
// may hold a thread's topic exactly while it may hold the parent's. Three triggers enforce that (a
// parent's override change, a role change, reconnect replay); this file holds their shared pieces.

// computeReadableChannels narrows allowed to the NSFW content readable set: visible channels that
// are unlabelled, or labelled and acknowledged by user (one read, only when a labelled channel is
// visible). A thread in allowed takes its parent's label and consent (acknowledgements are keyed by
// the parent).
func (h *Hub) computeReadableChannels(ctx context.Context, database VisibilityReader, user *db.User, allowed map[int64]bool) (map[int64]bool, error) {
	channels, err := database.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("computeReadableChannels ListChannels: %w", err)
	}
	readable := make(map[int64]bool, len(allowed))
	for id := range allowed {
		readable[id] = true
	}
	var acked map[int64]bool
	isAcked := func(id int64) (bool, error) {
		if acked == nil {
			var ackErr error
			if acked, ackErr = database.ListNSFWAcknowledgedChannelIDs(ctx, user.ID); ackErr != nil {
				return false, fmt.Errorf("computeReadableChannels ListNSFWAcknowledgedChannelIDs: %w", ackErr)
			}
		}
		return acked[id], nil
	}
	// A DM is never labelled, so it only needs to count as known and skip the per-id lookup below.
	dmIDs, err := database.GetUserDMChannelIDs(ctx, user.ID)
	if err != nil {
		return nil, fmt.Errorf("computeReadableChannels GetUserDMChannelIDs: %w", err)
	}
	known := make(map[int64]struct{}, len(channels)+len(dmIDs))
	for _, id := range dmIDs {
		known[id] = struct{}{}
	}
	for i := range channels {
		ch := &channels[i]
		known[ch.ID] = struct{}{}
		if !ch.NSFW || !allowed[ch.ID] {
			continue
		}
		ok, ackErr := isAcked(ch.ID)
		if ackErr != nil {
			return nil, ackErr
		}
		if !ok {
			delete(readable, ch.ID)
		}
	}
	// Anything allowed that the channel list does not carry is a thread.
	for id := range allowed {
		if _, ok := known[id]; ok {
			continue
		}
		ch, err := database.GetChannel(ctx, id)
		if err != nil {
			return nil, fmt.Errorf("computeReadableChannels GetChannel: %w", err)
		}
		if ch == nil || !ch.NSFW {
			continue
		}
		ok, ackErr := isAcked(ch.AuthorityID())
		if ackErr != nil {
			return nil, ackErr
		}
		if !ok {
			delete(readable, id)
		}
	}
	return readable, nil
}

// admitHeldThread adds to allowed the threads user's live sockets hold in their second slots when
// the parent is visible. computeAllowedChannels lists parents only, so otherwise a role-change
// revoke or reconnect replay would treat the held thread as unreadable. Visibility comes from the
// parent's entry, never the thread row alone.
func (h *Hub) admitHeldThread(ctx context.Context, database VisibilityReader, userID int64, allowed map[int64]bool) error {
	for _, live := range h.clientsOf(userID) {
		tid := live.getThreadID()
		if tid == 0 {
			continue
		}
		ch, err := database.GetChannel(ctx, tid)
		if err != nil {
			return fmt.Errorf("admitHeldThread GetChannel: %w", err)
		}
		if ch != nil && ch.IsThread() && allowed[ch.Thread.ParentID] {
			allowed[tid] = true
		}
	}
	return nil
}

// revokeHeldThread releases the thread in live's second slot when it belongs to parentID, the
// channel live just lost. It walks sockets, not the parent's threads (there may be hundreds). The
// parent is immutable, so the lookup cannot race a move; an unresolvable thread counts as belonging
// (revoke rather than keep). No frame: the parent's channel_delete closes the panel.
func (h *Hub) revokeHeldThread(ctx context.Context, live *Client, parentID int64) {
	tid := live.getThreadID()
	if tid == 0 {
		return
	}
	ch, err := h.readers.Visibility.GetChannel(ctx, tid)
	if err != nil || ch == nil || !ch.IsThread() || ch.Thread.ParentID == parentID {
		h.releaseThreadSocket(live, tid, nil)
	}
}

// roleThreadVerdict settles a held thread topic for the role worker without a frame: the thread
// inherits its parent's verdict, from the round's decision when the parent is in it, else resolved
// through the thread's own subject.
func (h *Hub) roleThreadVerdict(ctx context.Context, uid int64, ch *db.Channel, allowed map[int64]bool) (bool, error) {
	if v, decided := allowed[ch.Thread.ParentID]; decided {
		return v, nil
	}
	sub, err := h.subjectFor(ctx, uid, ch.ID)
	if err != nil {
		return false, err
	}
	sub.Channel = channelRef(ch)
	return permissions.CanViewChannel(sub) == nil, nil
}
