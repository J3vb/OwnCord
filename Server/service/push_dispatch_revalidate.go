package service

// The two checks dispatch runs immediately before every delivery attempt, including the first: they make a
// saved, never-re-encrypted request and a pre-dispatch audience snapshot safe to act on.

import (
	"context"
	"log/slog"
	"time"
)

// subscriptionStillCurrent re-reads, just before one attempt, the subscription row the item's request was
// built from and reports whether it is still the SAME subscription: id, owner, endpoint, credentials, and
// signing VAPID key. Nothing re-encrypts item.req, so a row deleted, replaced, or rotated onto a new VAPID
// key would otherwise still get a push encrypted for credentials it no longer has, possibly delivered to an
// endpoint the user disowned. Fails closed on every lookup error and on a row absent from the listing (which
// filters on the RUNNING key, so a rotated key looks like a deletion). Reusing that listing keeps the lookup
// on the indexed path.
func (d *PushDispatcher) subscriptionStillCurrent(ctx context.Context, item pushRoundItem) bool {
	subs, err := d.st.ListPushSubscriptionsForDispatch(ctx, []int64{item.sub.UserID}, d.push.currentKeyID())
	if err != nil {
		slog.Error("PushDispatcher.subscriptionStillCurrent ListPushSubscriptionsForDispatch",
			"err", err, "user_id", item.sub.UserID)
		return false
	}
	for _, s := range subs {
		if s.ID != item.sub.ID {
			continue
		}
		return s.Endpoint == item.sub.Endpoint &&
			s.P256dh == item.sub.P256dh &&
			s.Auth == item.sub.Auth
	}
	return false
}

// recipientBlocksAuthor re-asks the one (recipient, author) pair just before an attempt rather than trusting
// the audience-wide blocker set: a dispatch spans up to three rounds plus fetch deadlines, long enough for a
// block, which withdraws consent to be contacted. Fails closed: an unanswerable check is blocked.
func (d *PushDispatcher) recipientBlocksAuthor(ctx context.Context, userID, authorID int64) bool {
	blocked, err := d.st.IsBlocked(ctx, userID, authorID)
	if err != nil {
		slog.Error("PushDispatcher.recipientBlocksAuthor IsBlocked", "err", err, "user_id", userID)
		return true
	}
	return blocked
}

// prune deletes a subscription a push service reported dead (404/410) and counts it.
func (d *PushDispatcher) prune(ctx context.Context, id int64) {
	if deleted, err := d.st.DeletePushSubscriptionByID(ctx, id); err != nil {
		slog.Error("PushDispatcher.prune DeletePushSubscriptionByID", "err", err, "id", id)
		d.failed.Add(1)
	} else if deleted {
		d.pruned.Add(1)
	}
}

// expireCoalesceLocked removes every entry whose window has expired. Called with d.mu held. A linear scan per
// call, bounded by pushCoalesceMapCap.
func (d *PushDispatcher) expireCoalesceLocked(now time.Time) {
	for k, t := range d.lastSent {
		if now.Sub(t) >= pushCoalesceWindow {
			delete(d.lastSent, k)
		}
	}
}
