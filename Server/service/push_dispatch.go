package service

import (
	"context"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/safefetch"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// pushActivityPayload is the ONLY payload dispatch ever sends: no text, channel,
// sender or count, and no configuration widens it. The client fetches detail from
// its own server after waking.
var pushActivityPayload = []byte(`{"t":"activity"}`)

// pushCoalesceWindow bounds how often one user is pushed about one channel: a
// burst earns one notification per window. In memory; a restart forgets it, at
// worst one extra push.
const pushCoalesceWindow = 60 * time.Second

// pushCoalesceMapCap bounds the coalescer's memory: past this many live entries a
// brand-new pair is refused rather than evicting one, since an evicted entry still
// inside its window would be pushed again early. A ceiling against unbounded
// growth, not a tuned capacity.
const pushCoalesceMapCap = 10000

// pushDispatchTimeout bounds one Notify end to end (lookups, every subscription,
// every retry). Generous because a push is a hint with no caller waiting.
const pushDispatchTimeout = 60 * time.Second

// pushMaxConcurrentSends bounds concurrent deliveries per round, within the
// shared pushFetcher's MaxConcurrent (8), so slow endpoints cannot starve the rest.
const pushMaxConcurrentSends = 4

// pushMaxAttempts is the retry budget per subscription: the first attempt plus
// two retries.
const pushMaxAttempts = 3

// pushRetryBackoffs is the backoff schedule between rounds. Only the first two
// are used (pushMaxAttempts caps at 3 rounds); the third keeps the exponential
// curve (1s, 4s, 16s) explicit. Each wait runs once per round, after round N's
// fetches returned, so it is outside any attempt's fetch deadline.
var pushRetryBackoffs = []time.Duration{time.Second, 4 * time.Second, 16 * time.Second}

// PushNotifier is installed on MessageService when dispatch is on; nil means off
// (push.enabled or push.dispatch_enabled false) and SendMessage skips the hook.
type PushNotifier interface {
	// Notify considers a generic-content push for a message by authorID in channelID.
	// candidateIDs is the caller's pre-narrowed seed (direct @mentions, or a DM's
	// participants); Notify applies every other filter itself (author, blocked,
	// group-DM, online, permission, NSFW label, coalescing). It never returns an
	// error: failures are counted, not surfaced to the send path.
	Notify(ctx context.Context, channelID, authorID int64, candidateIDs []int64)
}

// PushFetcher is the safefetch surface dispatch needs: *safefetch.Fetcher in
// production, a stub in every test so none dials a real push service.
type PushFetcher interface {
	Fetch(ctx context.Context, req safefetch.Request) (*safefetch.Response, error)
}

// pushPolicy is dispatch's safefetch.Policy: https/443 only, no redirects, a
// small deadline and byte ceiling (a push body is a few hundred bytes), the
// content types push services answer with (including an error page's text/html),
// and a concurrency cap. A function so a _test.go file can reuse the ceilings with
// one seam swapped (TestProductionPolicyShape still sees the literal).
func pushPolicy() safefetch.Policy {
	return safefetch.Policy{
		Schemes:              []string{"https"},
		Ports:                []int{443},
		ContentTypes:         []string{"text/plain", "application/json", "text/html"},
		MaxRedirects:         0,
		Deadline:             10 * time.Second,
		MaxBytes:             64 << 10,
		MaxDecompressedBytes: 64 << 10,
		MaxConcurrent:        8,
	}
}

// pushFetcher is the one production Fetcher: one shared pool and concurrency cap.
var pushFetcher = safefetch.MustNew(pushPolicy())

type pushCoalesceKey struct {
	userID    int64
	channelID int64
}

// pushRoundItem is one subscription's state between rounds: the request is built
// once (encryption and VAPID signing) and re-sent unchanged. It snapshots the
// endpoint, credentials and signing VAPID key at Notify time, so re-sending is
// safe only because subscriptionStillCurrent re-reads the row before every
// attempt and refuses if any moved; the saved bytes are never re-encrypted.
type pushRoundItem struct {
	sub db.PushSubscriptionForDispatch
	req safefetch.Request
}

// PushDispatcher is the composition root's PushNotifier: resolves the audience,
// coalesces, encrypts and sends, retries transient failures within a budget,
// prunes dead subscriptions and counts outcomes. Constructed only when both
// push.enabled and push.dispatch_enabled are true.
type PushDispatcher struct {
	st     Store
	perms  *PermissionService
	push   *PushService
	online func(userID int64) bool
	fetch  PushFetcher
	// sleep backs the retry backoff; a seam for tests, cancellable by ctx so a
	// dispatch past its deadline stops waiting.
	sleep func(ctx context.Context, d time.Duration)

	mu       syncutil.Mutex
	lastSent map[pushCoalesceKey]time.Time

	dispatched atomic.Uint64
	failed     atomic.Uint64
	pruned     atomic.Uint64
}

// NewPushDispatcher constructs a PushDispatcher. fetch is nil in production (the
// shared pushFetcher); tests pass a stub.
func NewPushDispatcher(st Store, perms *PermissionService, push *PushService, online func(int64) bool, fetch PushFetcher) *PushDispatcher {
	if fetch == nil {
		fetch = pushFetcher
	}
	return &PushDispatcher{
		st:       st,
		perms:    perms,
		push:     push,
		online:   online,
		fetch:    fetch,
		sleep:    sleepUnlessDone,
		lastSent: make(map[pushCoalesceKey]time.Time),
	}
}

func sleepUnlessDone(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
	}
}

// Counters reports the aggregate push_dispatched, push_failed, push_pruned
// counts, never per user.
func (d *PushDispatcher) Counters() (dispatched, failed, pruned uint64) {
	return d.dispatched.Load(), d.failed.Load(), d.pruned.Load()
}

// Notify implements PushNotifier.
func (d *PushDispatcher) Notify(ctx context.Context, channelID, authorID int64, candidateIDs []int64) {
	ctx, cancel := context.WithTimeout(ctx, pushDispatchTimeout)
	defer cancel()

	ch, err := d.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return
	}
	// A labelled channel still pushes, to a recipient who acknowledged the label:
	// eligibleFor (via coalesceAudience and again in stillEligible) resolves that per
	// candidate through permissions.CanReadContent, so there is no whole-channel
	// early return. Only one-to-one DMs are in scope; a group DM is also
	// Type == "dm", so check it. Fail closed: a lookup error counts as a group.
	if ch.Type == "dm" {
		isGroup, gErr := d.st.IsGroupDM(ctx, channelID)
		if gErr != nil || isGroup {
			return
		}
	}

	// A user who blocked the author must never be pushed about their message (the
	// exclusion mentions.go applies to badges). Fail closed: a lookup failure drops
	// the round.
	blockers, err := d.st.ListBlockersOf(ctx, authorID)
	if err != nil {
		slog.Error("PushDispatcher.Notify ListBlockersOf", "err", err, "user_id", authorID)
		return
	}
	blockedByAuthor := make(map[int64]bool, len(blockers))
	for _, b := range blockers {
		blockedByAuthor[b] = true
	}

	// Cheapest in-memory filters first, then one subscriptions read for survivors,
	// then per-user permission and trust reads only for subscribed users: a ping of a
	// 2,000-holder role costs one query plus a few reads.
	pre := d.prefilterAudience(candidateIDs, authorID, ch.ID, blockedByAuthor)
	if len(pre) == 0 {
		return
	}
	keyID := d.push.currentKeyID()
	subs, err := d.st.ListPushSubscriptionsForDispatch(ctx, pre, keyID)
	if err != nil {
		slog.Error("PushDispatcher.Notify ListPushSubscriptionsForDispatch", "err", err, "channel_id", channelID)
		return
	}
	coalesced := d.coalesceAudience(ctx, ch, subscribedUserIDs(subs), authorID)
	if len(coalesced) == 0 {
		return
	}
	allowed := make(map[int64]bool, len(coalesced))
	for _, uid := range coalesced {
		allowed[uid] = true
	}
	subs = slices.DeleteFunc(subs, func(sub db.PushSubscriptionForDispatch) bool { return !allowed[sub.UserID] })

	// Reserve the coalescing window only once a user has a prepared request, so a
	// missing subscription or failed lookup never suppresses a later mention. A user
	// who loses the reservation to a concurrent Notify has their items dropped (no
	// double send).
	now := time.Now()
	reserved := make(map[int64]bool, len(coalesced))
	items := make([]pushRoundItem, 0, len(subs))
	for _, sub := range subs {
		req, ok := d.prepareRequest(sub)
		if !ok {
			continue
		}
		won, seen := reserved[sub.UserID]
		if !seen {
			won = !d.coalesced(sub.UserID, channelID, now)
			reserved[sub.UserID] = won
		}
		if won {
			items = append(items, pushRoundItem{sub: sub, req: req})
		}
	}

	// Round-based delivery: every item's Nth attempt runs through the bounded pool
	// before any item's (N+1)th. A per-subscription attempt-retry-backoff loop let a
	// few slow endpoints hold pool slots through every retry and starve
	// subscriptions that had not had a first attempt.
	for attempt := 1; attempt <= pushMaxAttempts && len(items) > 0; attempt++ {
		if attempt > 1 {
			d.sleep(ctx, pushRetryBackoffs[attempt-2])
		}
		items = d.runRound(ctx, channelID, authorID, items, attempt)
	}
}

// runRound performs attempt (1-based) for every item, bounded by
// pushMaxConcurrentSends, and returns the items to retry in a later round.
func (d *PushDispatcher) runRound(ctx context.Context, channelID, authorID int64, items []pushRoundItem, attempt int) []pushRoundItem {
	sem := make(chan struct{}, pushMaxConcurrentSends)
	var wg sync.WaitGroup
	var mu syncutil.Mutex
	retry := make([]pushRoundItem, 0, len(items))
	for i := range items {
		item := &items[i]
		wg.Add(1)
		sem <- struct{}{}
		go func(item *pushRoundItem) {
			defer wg.Done()
			defer func() { <-sem }()
			if d.attemptOne(ctx, channelID, authorID, *item, attempt) {
				mu.Lock()
				retry = append(retry, *item)
				mu.Unlock()
			}
		}(item)
	}
	wg.Wait()
	return retry
}

// prepareRequest builds the fixed, never re-encrypted safefetch.Request once:
// decode the credential, encrypt the generic payload, sign a VAPID header. A
// failure is terminal and unrelated to reachability: counted failed, never retried.
func (d *PushDispatcher) prepareRequest(sub db.PushSubscriptionForDispatch) (safefetch.Request, bool) {
	p256dh, err := decodePushBase64(sub.P256dh)
	if err != nil {
		d.failed.Add(1)
		return safefetch.Request{}, false
	}
	authSecret, err := decodePushBase64(sub.Auth)
	if err != nil {
		d.failed.Add(1)
		return safefetch.Request{}, false
	}
	body, err := encryptWebPushMessage(pushActivityPayload, p256dh, authSecret)
	if err != nil {
		d.failed.Add(1)
		return safefetch.Request{}, false
	}
	authorization, err := d.push.vapidAuthorization(sub.Endpoint)
	if err != nil {
		d.failed.Add(1)
		return safefetch.Request{}, false
	}
	return safefetch.Request{
		Method: http.MethodPost,
		URL:    sub.Endpoint,
		Body:   body,
		Header: map[string]string{
			"Authorization":    authorization,
			"Content-Encoding": "aes128gcm",
			"TTL":              "86400",
			"Urgency":          "normal",
			"Content-Type":     "application/octet-stream",
		},
	}, true
}

// attemptOne performs one delivery attempt for item, re-checking eligibility
// first. It reports whether to retry in a later round; every terminal outcome
// (success, prune, non-retryable failure, exhausted budget) lands in exactly one
// counter before returning false.
func (d *PushDispatcher) attemptOne(ctx context.Context, channelID, authorID int64, item pushRoundItem, attempt int) bool {
	// Subscription first, then eligibility: this pair makes the saved, never
	// re-encrypted item.req safe to re-send. Both run before every fetch, the first
	// included (a saturated pool can hold it a whole round), so a revocation or block
	// anywhere in the dispatch's lifetime stops the work.
	if !d.subscriptionStillCurrent(ctx, item) {
		return false
	}
	if !d.stillEligible(ctx, channelID, authorID, item.sub.UserID) {
		return false
	}
	resp, err := d.fetch.Fetch(ctx, item.req)
	if err == nil {
		switch {
		case resp.StatusCode == http.StatusCreated:
			d.dispatched.Add(1)
			return false
		case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
			d.prune(ctx, item.sub.ID)
			return false
		case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
			// Transient: retry in a later round if the budget allows.
		default:
			d.failed.Add(1)
			return false
		}
	}
	if attempt == pushMaxAttempts {
		d.failed.Add(1)
		return false
	}
	return true
}

// trustsAuthor reports whether a 1:1 DM push to uid may proceed: always true
// outside a "dm" channel, else the trusted_senders lookup DMAudience /
// DMDeliveryAudience use. Fails closed on a lookup error.
func (d *PushDispatcher) trustsAuthor(ctx context.Context, ch *db.Channel, uid, authorID int64) bool {
	if ch.Type != "dm" {
		return true
	}
	trusted, err := d.st.IsTrustedSender(ctx, uid, authorID)
	return err == nil && trusted
}

// eligibleFor reports whether userID may be pushed to for ch now: not connected
// (their client has the message) and permitted to READ ch's content via
// permissions.CanReadContent, the predicate every read path uses, so a labelled
// channel gets no push to a non-viewer or a viewer who has not acknowledged the
// label (no bit or admin bypass skips this). NSFWAcknowledged is read live only
// when ch.NSFW. Fails closed. ch is the caller's resolved channel; use
// stillEligible when it must be re-fetched.
func (d *PushDispatcher) eligibleFor(ctx context.Context, ch *db.Channel, userID int64) bool {
	if d.online != nil && d.online(userID) {
		return false
	}
	sub, err := channelSubject(ctx, d.st, d.perms, userID, ch, false)
	if err != nil {
		return false
	}
	if ch.NSFW {
		sub.Channel.NSFW = true
		ok, ackErr := d.st.HasNSFWAcknowledgement(ctx, userID, ch.ID)
		sub.NSFWAcknowledged = ackErr == nil && ok
	}
	return permissions.CanReadContent(sub) == nil
}

// stillEligible re-resolves, just before one delivery attempt, what can change
// while a bounded dispatch is in flight: the recipient blocked the author, came
// online, the channel became NSFW-labelled or an acknowledgement was revoked
// (eligibleFor's CanReadContent covers both), the recipient lost CanViewChannel,
// or, for a 1:1 DM, no longer trusts the author (trustsAuthor).
//
// The block is re-asked PER ATTEMPT because coalesceAudience's blockers map is a
// snapshot, and a dispatch spans up to three rounds over a 1s/4s backoff plus a
// 10s fetcher deadline, long enough for a block. A block withdraws consent to be
// contacted, so retries must not fire; IsBlocked asks the one pair, a single
// indexed lookup per attempt. Called before every attempt, first and retry alike.
func (d *PushDispatcher) stillEligible(ctx context.Context, channelID, authorID, userID int64) bool {
	if d.recipientBlocksAuthor(ctx, userID, authorID) {
		return false
	}
	ch, err := d.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return false
	}
	if !d.trustsAuthor(ctx, ch, userID, authorID) {
		return false
	}
	return d.eligibleFor(ctx, ch, userID)
}

// recentlySent is the read-only half of coalesced: whether userID is inside an
// open window for channelID, without starting one.
func (d *PushDispatcher) recentlySent(userID, channelID int64, now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	last, ok := d.lastSent[pushCoalesceKey{userID, channelID}]
	return ok && now.Sub(last) < pushCoalesceWindow
}

// coalesced reports whether userID was already pushed about channelID within
// pushCoalesceWindow. If not, and the map has room (see expireCoalesceLocked), it
// starts a window and returns false; at capacity even after expiring stale
// entries the new pair is refused (reported coalesced) rather than evicting an
// active window.
func (d *PushDispatcher) coalesced(userID, channelID int64, now time.Time) bool {
	key := pushCoalesceKey{userID, channelID}
	d.mu.Lock()
	defer d.mu.Unlock()
	if last, ok := d.lastSent[key]; ok && now.Sub(last) < pushCoalesceWindow {
		return true
	}
	d.expireCoalesceLocked(now)
	if len(d.lastSent) >= pushCoalesceMapCap {
		return true
	}
	d.lastSent[key] = now
	return false
}
