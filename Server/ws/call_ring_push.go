package ws

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/service"
)

// RingPusher carries a DM call's ring to phones by push: the ring itself, and its end when the callee
// answers or declines anywhere or the caller leaves. The bookkeeping methods run on the caller's goroutine
// and return what to send; SendRing does the network work on the hub's background group.
// *service.PushDispatcher implements it.
type RingPusher interface {
	RingStarted(channelID, callerID int64, targets []int64) service.RingPush
	RingAnswered(channelID, userID int64) service.RingPush
	RingLeft(channelID, userID int64) service.RingPush
	SendRing(ctx context.Context, p service.RingPush)
}

// ringPusherBox lets an interface sit in an atomic.Pointer.
type ringPusherBox struct{ p RingPusher }

// SetRingPusher installs phone ring push; nil (the default) turns it off. Safe while the hub runs.
func (h *Hub) SetRingPusher(p RingPusher) {
	if p == nil {
		h.ringPush.Store(nil)
		return
	}
	h.ringPush.Store(&ringPusherBox{p: p})
}

// callRingPush is the ring handlers' view of the hub's ring push; nil in handler tests.
type callRingPush interface {
	ringStarted(ctx context.Context, channelID, callerID int64, targets []int64)
	ringAnswered(ctx context.Context, channelID, userID int64)
}

func (h *Hub) ringStarted(ctx context.Context, channelID, callerID int64, targets []int64) {
	h.pushRing(ctx, func(p RingPusher) service.RingPush { return p.RingStarted(channelID, callerID, targets) })
}

func (h *Hub) ringAnswered(ctx context.Context, channelID, userID int64) {
	h.pushRing(ctx, func(p RingPusher) service.RingPush { return p.RingAnswered(channelID, userID) })
}

func (h *Hub) ringLeft(ctx context.Context, channelID, userID int64) {
	h.pushRing(ctx, func(p RingPusher) service.RingPush { return p.RingLeft(channelID, userID) })
}

// pushRing records the change now, so the order of ring, answer and leave is the order they happened, and
// sends the push on the hub's background group: detached from the frame's deadline, ended by hub stop.
func (h *Hub) pushRing(ctx context.Context, record func(RingPusher) service.RingPush) {
	box := h.ringPush.Load()
	if box == nil {
		return
	}
	push := record(box.p)
	if push.Empty() {
		return
	}
	if !h.lifecycle.background.Go(ctx, func(jobCtx context.Context) { box.p.SendRing(jobCtx, push) }) {
		slog.Info("ring push skipped, hub is stopping", "channel_id", push.ChannelID, "end", push.End)
	}
}
