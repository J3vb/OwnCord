package service

// The two checks dispatch runs immediately before every delivery attempt,
// including the first: they make a saved, never-re-encrypted request and a
// pre-dispatch audience snapshot safe to act on. Reachable only through
// attemptOne and stillEligible.

import (
	"context"
	"log/slog"
	"time"
)

// subscriptionStillCurrent re-reads, just before one attempt, the subscription row
// the item's request was built from and reports whether it is still the SAME
// subscription: row id, owner, endpoint, credentials, and the VAPID key the request
// was signed with.
// Nothing re-encrypts item.req (prepareRequest encrypts once and retries re-send
// those bytes), so a row deleted (the user revoked this device), replaced, or
// rotated onto a new VAPID key would otherwise still get a push encrypted for
// credentials it no longer has: undecryptable at best, delivered to an endpoint the
// user disowned at worst. Fails closed on every lookup error and on a row absent
// from the listing (ListPushSubscriptionsForDispatch filters on the RUNNING key, so
// a rotated key looks like a deletion).
// Reusing that listing instead of a get-by-id keeps the lookup on the indexed path
// the audience query takes; it is one query per attempt, scoped to the one user,
// against a network fetch under a 10s deadline.
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

// recipientBlocksAuthor re-asks the one (recipient, author) pair just before an
// attempt rather than trusting the audience-wide blocker set read before dispatch:
// a dispatch spans up to three rounds over a 1s/4s backoff plus a 10s fetch
// deadline, long enough for the recipient to block the author in between, and a
// block withdraws consent to be contacted so the retries must not fire. A single
// indexed lookup (Store.IsBlocked). Fails closed: an unanswerable check is blocked.
func (d *PushDispatcher) recipientBlocksAuthor(ctx context.Context, userID, authorID int64) bool {
	blocked, err := d.st.IsBlocked(ctx, userID, authorID)
	if err != nil {
		slog.Error("PushDispatcher.recipientBlocksAuthor IsBlocked", "err", err, "user_id", userID)
		return true
	}
	return blocked
}

// prune deletes a subscription a push service reported dead (404/410) and counts
// it, the authoritative staleness signal apart from the time-based sweep.
func (d *PushDispatcher) prune(ctx context.Context, id int64) {
	if deleted, err := d.st.DeletePushSubscriptionByID(ctx, id); err != nil {
		slog.Error("PushDispatcher.prune DeletePushSubscriptionByID", "err", err, "id", id)
		d.failed.Add(1)
	} else if deleted {
		d.pruned.Add(1)
	}
}

// expireCoalesceLocked removes every entry whose window has expired. Called with
// d.mu held. ponytail: a linear scan per call, bounded by pushCoalesceMapCap;
// move to a ticker or time-ordered structure if the cap grows enough to show in
// profiles.
func (d *PushDispatcher) expireCoalesceLocked(now time.Time) {
	for k, t := range d.lastSent {
		if now.Sub(t) >= pushCoalesceWindow {
			delete(d.lastSent, k)
		}
	}
}
