package ws

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// The thread half of channel visibility. A thread has no permission
// state of its own, so a socket may hold a thread's topic exactly while it may
// hold the parent's. Three paths enforce that, each from a different trigger:
// a parent's override change (RefreshChannelVisibility), a role change
// (revokeUnreadableChannels and the role worker), and reconnect replay. This
// file holds their shared pieces.

// computeReadableChannels narrows allowed (the visible set) to the NSFW
// content readable set: every visible channel that is either not labelled, or
// labelled and acknowledged by user. Bounded by how many labelled channels
// sit in the visible set (typically zero), not by the full channel list.
//
// A thread in allowed (admitThreads put it there for a socket that holds it)
// takes its parent's label and consent: the thread row carries the parent's
// NSFW flag and the acknowledgement read resolves to the parent, so it is
// narrowed exactly like the parent would be.
func (h *Hub) computeReadableChannels(ctx context.Context, database VisibilityReader, user *db.User, allowed map[int64]bool) (map[int64]bool, error) {
	channels, err := database.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("computeReadableChannels ListChannels: %w", err)
	}
	readable := make(map[int64]bool, len(allowed))
	for id := range allowed {
		readable[id] = true
	}
	known := make(map[int64]struct{}, len(channels))
	for i := range channels {
		ch := &channels[i]
		known[ch.ID] = struct{}{}
		if !ch.NSFW || !allowed[ch.ID] {
			continue
		}
		ok, ackErr := database.HasNSFWAcknowledgement(ctx, user.ID, ch.ID)
		if ackErr != nil {
			return nil, fmt.Errorf("computeReadableChannels HasNSFWAcknowledgement: %w", ackErr)
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
		ok, ackErr := database.HasNSFWAcknowledgement(ctx, user.ID, id)
		if ackErr != nil {
			return nil, fmt.Errorf("computeReadableChannels HasNSFWAcknowledgement: %w", ackErr)
		}
		if !ok {
			delete(readable, id)
		}
	}
	return readable, nil
}

// admitHeldThread adds to allowed the threads user's live sockets hold in their
// second slots, when that thread's parent is visible. computeAllowedChannels
// lists parent channels only, so without this a role-change revoke or a
// reconnect replay would treat the held thread as unreadable (or, for replay,
// drop its frames). Visibility comes from the parent's entry in allowed, never
// from the thread row alone: a parent the user cannot see admits nothing.
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

// revokeHeldThread releases the thread in live's second slot when it belongs
// to parentID, the channel live just lost. It walks the sockets, not the
// parent's threads (a parent can have hundreds): the caller visits each
// connected socket anyway, and only one that holds a thread costs a lookup.
// The thread's parent is immutable, so the lookup cannot race a move. A thread
// that cannot be resolved counts as belonging, so a failure revokes rather
// than keeps. It sends no frame: the parent's channel_delete already tells the
// client to close the panel.
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

// roleThreadVerdict settles a held thread topic for the role worker without a
// frame: the thread inherits its parent's verdict, taken from the round's own
// decision when the parent is in it, otherwise resolved through the thread's
// own subject (which is the parent's by inheritance).
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
