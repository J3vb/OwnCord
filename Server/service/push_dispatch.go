package service

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/safefetch"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// pushActivityPayload is the ONLY payload dispatch ever sends (HP-5
// scorecard Question 6, decision 2): no message text, channel id or name,
// sender, or count, and no configuration widens it. The client fetches the
// detail from its own server after waking.
var pushActivityPayload = []byte(`{"t":"activity"}`)

// pushCoalesceWindow bounds how often one user is pushed about one channel:
// a burst of messages earns at most one notification per window. An
// in-memory map with expiry -- a restart forgets it, which is fine, because
// the worst case is one extra push right after a restart.
const pushCoalesceWindow = 60 * time.Second

// pushCoalesceMapCap bounds the coalescer's memory: past this many live
// (unexpired) entries, a brand-new pair is refused admission rather than
// evicting one of them -- an evicted-but-still-inside-its-window entry
// would let that pair be pushed again before its 60s were actually up.
// 10000 concurrently "recently pushed" (user, channel) pairs is far past
// anything a self-hosted deployment produces; this is a ceiling against an
// unbounded growth path, not a tuned capacity.
const pushCoalesceMapCap = 10000

// pushDispatchTimeout bounds one Notify call end to end: the channel and
// permission lookups, every subscriber's subscriptions, and every attempt
// (including retries) against every one of them. It is generous rather than
// tight because a push is a hint with no caller waiting on it -- the request
// that triggered it has already returned.
const pushDispatchTimeout = 60 * time.Second

// pushMaxConcurrentSends bounds how many subscriptions one round delivers to
// at once, within the shared pushFetcher's own MaxConcurrent (8): a handful
// of slow or stuck endpoints must not serialise behind each other and starve
// the rest of the round.
const pushMaxConcurrentSends = 4

// pushMaxAttempts is the retry budget for one subscription: the initial
// attempt plus two retries, backing off by pushRetryBackoffs between them.
const pushMaxAttempts = 3

// pushRetryBackoffs is the backoff schedule between rounds. Only the first
// two entries are ever used -- pushMaxAttempts caps the loop at 3 rounds,
// which needs 2 waits -- the third is kept so the schedule reads as the
// intended exponential curve (1s, 4s, 16s) rather than stopping short of it
// by coincidence. Each wait runs once per round (not once per subscription):
// round N's fetches have all already returned (or hit safefetch's own 10s
// policy deadline) before the wait for round N+1 starts, so it is always
// outside any one attempt's fetch deadline.
var pushRetryBackoffs = []time.Duration{time.Second, 4 * time.Second, 16 * time.Second}

// PushNotifier is installed on MessageService when dispatch is on; nil
// means dispatch is off (either push.enabled or push.dispatch_enabled is
// false), and MessageService.SendMessage skips the hook entirely.
type PushNotifier interface {
	// Notify considers dispatching a generic-content push for a message
	// authored by authorID in channelID. candidateIDs is the caller's
	// pre-narrowed audience seed: the message's direct @mentions for a
	// guild channel, or the DM's participant ids for a DM -- Notify applies
	// every remaining filter (author, blocked, group-DM, online, permission,
	// NSFW label, coalescing) itself. It never returns an error; failures
	// are counted, not surfaced to the send path a user is waiting on.
	Notify(ctx context.Context, channelID, authorID int64, candidateIDs []int64)
}

// PushFetcher is the safefetch surface dispatch needs. Satisfied by
// *safefetch.Fetcher in production; every test substitutes a stub so no
// test ever dials a real push service.
type PushFetcher interface {
	Fetch(ctx context.Context, req safefetch.Request) (*safefetch.Response, error)
}

// pushPolicy is dispatch's safefetch.Policy: https/443 only, no redirects, a
// small deadline and byte ceiling (a push body is a few hundred bytes), the
// content types a push service answers with (including an error page's
// text/html), and a concurrency cap. A function rather than a package var so
// a _test.go file can reuse these exact ceilings with one seam swapped in
// (TestPushDispatch_HostileEndpointResolvingPrivateIsRefused) without
// duplicating the numbers by hand; TestProductionPolicyShape still sees the
// literal wherever it is returned from.
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

// pushFetcher is the one production Fetcher for dispatch (plan decision,
// HP-5 scorecard Question 6 item 6): every subscriber, every message, one
// shared connection pool and concurrency cap.
var pushFetcher = safefetch.MustNew(pushPolicy())

// pushCoalesceKey is the coalescer's map key: one user, one channel.
type pushCoalesceKey struct {
	userID    int64
	channelID int64
}

// pushRoundItem is one subscription's state carried between dispatch
// rounds: the request is built once (encryption and VAPID signing happen a
// single time), and re-sent unchanged on every round it survives to.
type pushRoundItem struct {
	sub db.PushSubscriptionForDispatch
	req safefetch.Request
}

// PushDispatcher is the composition root's PushNotifier: it resolves the
// audience, coalesces, encrypts and sends, retries transient failures within
// a bounded budget, prunes dead subscriptions, and counts outcomes. It is
// constructed only when both push.enabled and push.dispatch_enabled are
// true; nothing else in this file runs otherwise.
type PushDispatcher struct {
	st     Store
	perms  *PermissionService
	push   *PushService
	online func(userID int64) bool
	fetch  PushFetcher
	// sleep backs the retry backoff; a seam so tests do not wait on a real
	// timer. Cancellable by ctx so a dispatch that outlives its deadline
	// stops waiting rather than sleeping past it.
	sleep func(ctx context.Context, d time.Duration)

	mu       syncutil.Mutex
	lastSent map[pushCoalesceKey]time.Time

	dispatched atomic.Uint64
	failed     atomic.Uint64
	pruned     atomic.Uint64
}

// NewPushDispatcher constructs a PushDispatcher. fetch is nil in production
// (the shared pushFetcher singleton is used); every test passes a stub that
// implements PushFetcher so no test ever reaches a real push service.
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

// Counters reports the aggregate outcome counts the metrics surface
// exposes: push_dispatched, push_failed, push_pruned. Never per user.
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
	// B5-7: a labelled channel still pushes -- to a recipient who has
	// acknowledged the label. eligibleFor (via coalesceAudience below, and
	// again in stillEligible's per-attempt recheck) resolves that per
	// candidate through permissions.CanReadContent, the same predicate every
	// content read path uses; there is no whole-channel early return here
	// because acknowledgement is per user, not per channel.
	// Only one-to-one DMs are in scope (plan decision 4's Message Requests
	// boundary and this step's own audience rule) -- a group DM has
	// Type == "dm" too, so it needs its own check. Fail closed: a lookup
	// error is treated the same as "it is a group", because a push to a
	// group we can no longer classify is not a risk worth taking.
	if ch.Type == "dm" {
		isGroup, gErr := d.st.IsGroupDM(ctx, channelID)
		if gErr != nil || isGroup {
			return
		}
	}

	// A user who has blocked the author must never be pushed about the
	// author's message -- the same exclusion applyMentionCounts applies to
	// mention badges (mentions.go). Fail closed: a lookup failure drops the
	// whole round rather than risk pushing someone who blocked the sender.
	blockers, err := d.st.ListBlockersOf(ctx, authorID)
	if err != nil {
		slog.Error("PushDispatcher.Notify ListBlockersOf", "err", err, "user_id", authorID)
		return
	}
	blockedByAuthor := make(map[int64]bool, len(blockers))
	for _, b := range blockers {
		blockedByAuthor[b] = true
	}

	coalesced := d.coalesceAudience(ctx, ch, candidateIDs, authorID, blockedByAuthor)
	if len(coalesced) == 0 {
		return
	}

	keyID := d.push.currentKeyID()
	subs, err := d.st.ListPushSubscriptionsForDispatch(ctx, coalesced, keyID)
	if err != nil {
		slog.Error("PushDispatcher.Notify ListPushSubscriptionsForDispatch", "err", err, "channel_id", channelID)
		return
	}

	items := make([]pushRoundItem, 0, len(subs))
	for _, sub := range subs {
		if req, ok := d.prepareRequest(sub); ok {
			items = append(items, pushRoundItem{sub: sub, req: req})
		}
	}

	// Round-based delivery: every surviving item's Nth attempt runs through
	// the bounded pool before any item's (N+1)th. A sequential
	// attempt-then-retry-then-backoff loop per subscription let a handful of
	// slow or failing endpoints hold their pool slot through every retry,
	// starving subscriptions that had not even had a first attempt yet; this
	// guarantees every item gets attempt N before any gets attempt N+1.
	for attempt := 1; attempt <= pushMaxAttempts && len(items) > 0; attempt++ {
		if attempt > 1 {
			d.sleep(ctx, pushRetryBackoffs[attempt-2])
		}
		items = d.runRound(ctx, channelID, authorID, items, attempt)
	}
}

// runRound performs attempt (1-based) for every item in items, bounded by
// pushMaxConcurrentSends concurrent sends, and returns the subset that
// should be retried in a later round.
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

// prepareRequest builds the (fixed, never re-encrypted) safefetch.Request
// for sub once: decoding its credential, encrypting the generic payload,
// and signing a VAPID header. Any failure here is terminal and unrelated to
// the destination being reachable, so it is counted failed once and never
// retried.
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

// attemptOne performs one delivery attempt (1-based attempt number) for
// item, re-checking eligibility immediately before it. It reports whether
// item should be retried in a later round; every terminal outcome (success,
// prune, non-retryable failure, or the retry budget running out) lands in
// exactly one counter before returning false.
func (d *PushDispatcher) attemptOne(ctx context.Context, channelID, authorID int64, item pushRoundItem, attempt int) bool {
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
			// transient -- retry in a later round if the budget allows
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

// coalesceAudience narrows candidateIDs to the users a push is actually
// sent to: distinct, not the author, not blocked by (a blocker of) the
// author, currently eligible (offline and permitted -- see eligibleFor),
// trusting the author if this is a one-to-one DM (see below), and not
// inside their coalescing window for ch.
//
// Eligibility is checked BEFORE coalescing, not after: an online or
// unauthorized candidate must not reserve the 60s window for a channel they
// were never going to be pushed about, or a later, genuinely eligible
// mention (the recipient came back online, or a mention five seconds after
// an ineligible one) would silently receive nothing. Eligibility is
// re-checked again immediately before every delivery attempt in
// stillEligible, because a bounded but potentially slow dispatch (retries,
// a worker pool) can take long enough for it to change again in the other
// direction.
//
// For a DM, permission IS participation (permissions.CanViewChannel checks
// only DMParticipant for a "dm" channel). Notify already refused a group DM
// before this is ever called (ch.Type == "dm" here always means one-to-one),
// so a DM push additionally requires that the candidate trusts the author --
// the same trusted_senders row Message Requests gates on and DMAudience /
// MessageRequestService.DMDeliveryAudience apply to chat_message delivery
// (service/message_crud.go, service/message_request.go) -- so a first-contact
// message from an unknown sender cannot ring a stranger's phone before they
// have decided to accept it. Fail closed: a lookup error is treated as
// untrusted, same as every other fail-closed check in this file.
func (d *PushDispatcher) coalesceAudience(ctx context.Context, ch *db.Channel, candidateIDs []int64, authorID int64, blockedByAuthor map[int64]bool) []int64 {
	seen := make(map[int64]bool, len(candidateIDs))
	out := make([]int64, 0, len(candidateIDs))
	now := time.Now()
	for _, uid := range candidateIDs {
		if uid == authorID || uid <= 0 || seen[uid] || blockedByAuthor[uid] {
			continue
		}
		seen[uid] = true
		if !d.eligibleFor(ctx, ch, uid) {
			continue
		}
		if !d.trustsAuthor(ctx, ch, uid, authorID) {
			continue
		}
		if d.coalesced(uid, ch.ID, now) {
			continue
		}
		out = append(out, uid)
	}
	return out
}

// trustsAuthor reports whether a one-to-one DM push to uid may proceed:
// always true outside a "dm" channel (ch.Type != "dm" -- guild channels have
// no trust rule), otherwise the same trusted_senders lookup DMAudience /
// MessageRequestService.DMDeliveryAudience use for chat_message delivery.
// Fail closed on a lookup error: no push.
func (d *PushDispatcher) trustsAuthor(ctx context.Context, ch *db.Channel, uid, authorID int64) bool {
	if ch.Type != "dm" {
		return true
	}
	trusted, err := d.st.IsTrustedSender(ctx, uid, authorID)
	return err == nil && trusted
}

// eligibleFor reports whether userID may be pushed to for ch right now:
// not currently connected (their client already has the message), and
// permitted to READ ch's content -- CanReadContent (permissions/predicates.go),
// the same predicate every content read path resolves, so a labelled channel
// is decided exactly the way REST/search/socket/attachments decide it: no
// push at all to a non-viewer, and no push to a viewer who has not
// acknowledged the label (decision 13 -- no bit and no admin bypass skips
// this). NSFWAcknowledged is read live from the db, only when ch.NSFW is
// set, never re-implementing the rule itself. Fails closed: any lookup
// error is treated as unacknowledged. ch is the caller's already-resolved
// channel; a caller that needs it re-fetched fresh (because time may have
// passed) uses stillEligible instead.
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

// stillEligible re-resolves, immediately before one delivery attempt, the
// things that can change while a bounded dispatch is in flight: the
// recipient came online, the channel was labelled nsfw (or their
// acknowledgement of an already-labelled channel was revoked -- eligibleFor's
// CanReadContent call covers both), the recipient lost CanViewChannel, or --
// for a one-to-one DM -- the recipient no longer trusts the author (they
// blocked them, or ignored/deleted the pending request between attempts: see
// trustsAuthor). Called before every attempt, first and retry alike, so a
// revoke mid-dispatch drops the remaining retries rather than delivering one
// anyway.
func (d *PushDispatcher) stillEligible(ctx context.Context, channelID, authorID, userID int64) bool {
	ch, err := d.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return false
	}
	if !d.trustsAuthor(ctx, ch, userID, authorID) {
		return false
	}
	return d.eligibleFor(ctx, ch, userID)
}

// coalesced reports whether userID was already pushed about channelID
// within pushCoalesceWindow. If not, and the map has room (see
// expireCoalesceLocked), it starts a new window from now and returns false;
// if the map is at capacity with no room even after expiring stale entries,
// the new pair is refused (reported as coalesced) rather than evicting a
// still-active window, which would let that evicted pair be pushed again
// before its own 60s were actually up.
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

// expireCoalesceLocked removes every entry whose window has already
// expired. Called with d.mu held.
//
// ponytail: a full linear scan on every call, bounded by pushCoalesceMapCap
// entries. Fine at that size; move to a background ticker or a
// time-ordered structure if the cap is ever raised enough for this to show
// up in profiles.
func (d *PushDispatcher) expireCoalesceLocked(now time.Time) {
	for k, t := range d.lastSent {
		if now.Sub(t) >= pushCoalesceWindow {
			delete(d.lastSent, k)
		}
	}
}

// prune deletes a subscription a push service reported dead (404/410) and
// counts it -- the authoritative staleness signal S7 names, separate from
// B5-4's time-based sweep.
func (d *PushDispatcher) prune(ctx context.Context, id int64) {
	if _, err := d.st.DeletePushSubscriptionByID(ctx, id); err != nil {
		slog.Error("PushDispatcher.prune DeletePushSubscriptionByID", "err", err, "id", id)
	}
	d.pruned.Add(1)
}
