package service

// push_dispatch_revalidate.go holds the two checks dispatch runs immediately
// before every delivery attempt, including the first: they are what make a
// saved, never-re-encrypted request and a pre-dispatch audience snapshot safe
// to act on (OC-0450). Split out of push_dispatch.go to keep that file under
// its declared size ceiling; nothing here is reachable except through
// attemptOne and stillEligible.

import (
	"context"
	"log/slog"
)

// subscriptionStillCurrent re-reads, immediately before one delivery attempt,
// the subscription row this item's request was built from, and reports
// whether it is still the SAME subscription: same row id, same owner, same
// endpoint, same credentials, and still scoped to the VAPID key the request
// was signed with.
//
// Nothing downstream re-encrypts item.req — prepareRequest encrypts to the
// recipient's public key once and the retry rounds re-send those exact bytes —
// so a row that has been deleted (the user revoked this device), replaced, or
// rotated onto a new VAPID key would otherwise still receive a push encrypted
// for the credentials it no longer has: undecryptable at best, delivered to an
// endpoint the user just disowned at worst. Fails closed on every lookup
// error, and on a row that is simply absent from the listing
// (ListPushSubscriptionsForDispatch filters on the RUNNING key, so a rotated
// key makes this the same miss as a deletion).
//
// Reusing the listing rather than adding a get-by-id keeps the lookup on the
// same indexed path the audience query already takes, and costs one query per
// attempt — an attempt is a network fetch under a 10s policy deadline, so this
// is not the round's bottleneck. Bounded by construction: one row is compared,
// and the query is scoped to the single user the item already names.
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

// recipientBlocksAuthor re-asks the one (recipient, author) pair immediately
// before a delivery attempt, rather than trusting the audience-wide blocker
// set coalesceAudience read once before the dispatch began: a dispatch spans
// up to three rounds across a 1s/4s backoff schedule plus a 10s fetcher
// deadline, which is long enough for the recipient to block the author in
// between. A block is a withdrawal of consent to be contacted, so the retries
// it lands between must not fire.
//
// Asking the pair rather than re-listing the server's blockers keeps this a
// single indexed lookup per attempt (see Store.IsBlocked). Fails closed: an
// unanswerable check is treated as blocked.
func (d *PushDispatcher) recipientBlocksAuthor(ctx context.Context, userID, authorID int64) bool {
	blocked, err := d.st.IsBlocked(ctx, userID, authorID)
	if err != nil {
		slog.Error("PushDispatcher.recipientBlocksAuthor IsBlocked", "err", err, "user_id", userID)
		return true
	}
	return blocked
}
