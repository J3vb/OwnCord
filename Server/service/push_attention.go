package service

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// A warning on the admin attention panel that turns critical reaches the server owner's phone as one generic
// push. The payload names no signal and no detail: the phone says only that the server needs attention, and
// the admin panel says what.

// pushAttentionPayload is the whole push body; nothing about the problem is ever added to it.
var pushAttentionPayload = []byte(`{"t":"attention"}`)

// pushAttentionHeaders: an hour is how long the news stays useful to a phone that is off, and high urgency
// asks the push service to wake a sleeping phone at once.
var pushAttentionHeaders = pushDelivery{ttl: "3600", urgency: "high"}

// ownerAudience returns the one account holding the owner role (the highest-position account, taken only
// when its role passes permissions.IsOwner), or nil when there is none: a server whose owner is gone does
// not hand the alert to the next highest account. Fails closed on a read error, which is logged.
func (d *PushDispatcher) ownerAudience(ctx context.Context) []int64 {
	u, err := d.st.GetOwnerUser(ctx)
	if err != nil {
		slog.Warn("PushDispatcher.ownerAudience GetOwnerUser", "err", err)
		return nil
	}
	if u == nil {
		return nil
	}
	role, err := d.st.GetRoleByID(ctx, u.RoleID)
	if err != nil {
		slog.Warn("PushDispatcher.ownerAudience GetRoleByID", "err", err, "user_id", u.ID)
		return nil
	}
	if role == nil || !permissions.IsOwner(role.ID, role.Position) {
		return nil
	}
	return []int64{u.ID}
}

// SendAttention delivers the generic attention push to every push subscription of the server owner, whether
// or not they look online. It does not skip Do Not Disturb: that status promises no call popup and no chat
// noise, and this is a rare, throttled notice about the owner's own server on a quiet channel. Never errors:
// no owner, no subscription or a failed delivery sends nothing or counts a failure.
func (d *PushDispatcher) SendAttention(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, pushDispatchTimeout)
	defer cancel()
	audience := d.ownerAudience(ctx)
	if len(audience) == 0 {
		return
	}
	subs, err := d.st.ListPushSubscriptionsForDispatch(ctx, audience, d.push.currentKeyID())
	if err != nil {
		slog.Error("PushDispatcher.SendAttention ListPushSubscriptionsForDispatch", "err", err)
		return
	}
	items := make([]pushRoundItem, 0, len(subs))
	for _, sub := range subs {
		if req, ok := d.prepareRequest(sub, pushAttentionPayload, pushAttentionHeaders); ok {
			items = append(items, pushRoundItem{sub: sub, req: req})
		}
	}
	for attempt := 1; attempt <= pushMaxAttempts && len(items) > 0; attempt++ {
		if attempt > 1 {
			d.sleep(ctx, pushRetryBackoffs[attempt-2])
		}
		items = d.runRound(items, func(item pushRoundItem) bool {
			if !d.subscriptionStillCurrent(ctx, item) {
				return false
			}
			return d.deliver(ctx, item, attempt == pushMaxAttempts)
		})
	}
}
