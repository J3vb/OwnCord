package service

import (
	"context"
	"log/slog"
	"net/http"
	"sort"
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
// entries, the oldest are evicted to make room, on top of the ordinary
// expiry sweep. 10000 concurrently "recently pushed" (user, channel) pairs
// is far past anything a self-hosted deployment produces; this is a ceiling
// against an unbounded growth path, not a tuned capacity.
const pushCoalesceMapCap = 10000

// pushDispatchTimeout bounds one Notify call end to end: the channel and
// permission lookups, every subscriber's subscriptions, and every attempt
// (including retries) against every one of them. It is generous rather than
// tight because a push is a hint with no caller waiting on it -- the request
// that triggered it has already returned.
const pushDispatchTimeout = 60 * time.Second

// pushMaxConcurrentSends bounds how many subscriptions Notify delivers to at
// once, within the shared pushFetcher's own MaxConcurrent (8): a handful of
// slow or stuck endpoints must not serialise behind each other and starve
// the rest of pushDispatchTimeout (a bare sequential loop did exactly that).
const pushMaxConcurrentSends = 4

// pushMaxAttempts is the retry budget for one subscription: the initial
// attempt plus two retries, backing off by pushRetryBackoffs between them.
const pushMaxAttempts = 3

// pushRetryBackoffs is the backoff schedule between attempts. Only the first
// two entries are ever used -- pushMaxAttempts caps the loop at 3 attempts,
// which needs 2 waits -- the third is kept so the schedule reads as the
// intended exponential curve (1s, 4s, 16s) rather than stopping short of it
// by coincidence. The wait happens after safefetch.Fetcher.Fetch has already
// returned (or timed out at its own 10s policy deadline), so it is always
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
	// B5-7: nsfw_acknowledgements does not exist on this branch (B5-7 is
	// behind HP-5 too and may not have merged yet). Once it does, a
	// subscriber with an acknowledgement row for this channel should still
	// receive the (generic) push; until then, gate on the label alone --
	// no push at all for a labelled channel. Re-checked per attempt in
	// stillEligible too, since dispatch can outlive a label change.
	if ch.NSFW {
		return
	}
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

	coalesced := d.coalesceAudience(candidateIDs, authorID, blockedByAuthor, channelID)
	if len(coalesced) == 0 {
		return
	}

	keyID := d.push.currentKeyID()
	subs, err := d.st.ListPushSubscriptionsForDispatch(ctx, coalesced, keyID)
	if err != nil {
		slog.Error("PushDispatcher.Notify ListPushSubscriptionsForDispatch", "err", err, "channel_id", channelID)
		return
	}

	// Bounded fan-out: a semaphore of pushMaxConcurrentSends, so a handful
	// of slow or stuck subscriptions run alongside healthy ones instead of
	// queuing behind them for the whole shared pushDispatchTimeout.
	sem := make(chan struct{}, pushMaxConcurrentSends)
	var wg sync.WaitGroup
	for _, sub := range subs {
		wg.Add(1)
		sem <- struct{}{}
		go func(sub db.PushSubscriptionForDispatch) {
			defer wg.Done()
			defer func() { <-sem }()
			d.sendOne(ctx, channelID, sub)
		}(sub)
	}
	wg.Wait()
}

// coalesceAudience narrows candidateIDs to the users a push is even worth
// attempting for: distinct, not the author, not blocked by (a blocker of)
// the author, and not inside their coalescing window for channelID.
//
// Permission and online state are deliberately NOT checked here: a bounded
// but potentially slow dispatch (retries, a bounded worker pool) can take
// long enough that either changes mid-flight, so both are re-checked
// immediately before every delivery attempt in stillEligible instead of
// once up front.
//
// For a DM, permission IS participation (permissions.CanViewChannel checks
// only DMParticipant for a "dm" channel), so a non-participant candidate is
// excluded by stillEligible the same way. B5-6: trusted_senders does not
// exist on this branch (B5-6 is behind HP-5 too and may not have merged
// yet). Once it does, a DM push should also require that the recipient
// trusts the sender -- the same row Message Requests gates on -- so a
// first-contact message from an unknown sender cannot ring a stranger's
// phone before they have decided to accept it.
func (d *PushDispatcher) coalesceAudience(candidateIDs []int64, authorID int64, blockedByAuthor map[int64]bool, channelID int64) []int64 {
	seen := make(map[int64]bool, len(candidateIDs))
	out := make([]int64, 0, len(candidateIDs))
	now := time.Now()
	for _, uid := range candidateIDs {
		if uid == authorID || uid <= 0 || seen[uid] || blockedByAuthor[uid] {
			continue
		}
		seen[uid] = true
		if d.coalesced(uid, channelID, now) {
			continue
		}
		out = append(out, uid)
	}
	return out
}

// stillEligible re-resolves, immediately before one delivery attempt, the
// three things that can change while a bounded dispatch is in flight: the
// recipient came online (their client already has the message), the
// channel was labelled nsfw, or the recipient lost CanViewChannel. Called
// before the first attempt and again before every retry.
func (d *PushDispatcher) stillEligible(ctx context.Context, channelID, userID int64) bool {
	if d.online != nil && d.online(userID) {
		return false
	}
	ch, err := d.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil || ch.NSFW {
		return false
	}
	sub, err := channelSubject(ctx, d.st, d.perms, userID, ch, false)
	if err != nil {
		return false
	}
	return permissions.CanViewChannel(sub) == nil
}

// coalesced reports whether userID was already pushed about channelID
// within pushCoalesceWindow, and if not, starts a new window from now.
func (d *PushDispatcher) coalesced(userID, channelID int64, now time.Time) bool {
	key := pushCoalesceKey{userID, channelID}
	d.mu.Lock()
	defer d.mu.Unlock()
	if last, ok := d.lastSent[key]; ok && now.Sub(last) < pushCoalesceWindow {
		return true
	}
	d.sweepCoalesceLocked(now)
	d.lastSent[key] = now
	return false
}

// sweepCoalesceLocked removes every entry whose window has already expired,
// then, if the map is still at pushCoalesceMapCap or over, evicts the
// oldest entries down under it. Called with d.mu held.
//
// ponytail: a full linear scan (and, on the rare cap-exceeded path, a full
// sort) on every call, bounded by pushCoalesceMapCap entries. Fine at that
// size; move to a background ticker or a time-ordered structure if the cap
// is ever raised enough for this to show up in profiles.
func (d *PushDispatcher) sweepCoalesceLocked(now time.Time) {
	for k, t := range d.lastSent {
		if now.Sub(t) >= pushCoalesceWindow {
			delete(d.lastSent, k)
		}
	}
	if len(d.lastSent) < pushCoalesceMapCap {
		return
	}
	type entry struct {
		key pushCoalesceKey
		at  time.Time
	}
	entries := make([]entry, 0, len(d.lastSent))
	for k, t := range d.lastSent {
		entries = append(entries, entry{k, t})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].at.Before(entries[j].at) })
	for _, e := range entries[:len(entries)-pushCoalesceMapCap+1] {
		delete(d.lastSent, e.key)
	}
}

// sendOne encrypts and POSTs one push to one subscription, re-checking
// eligibility and retrying a transient failure within pushMaxAttempts. It
// never returns an error; every outcome lands in exactly one counter (or
// none, if stillEligible refuses an attempt).
func (d *PushDispatcher) sendOne(ctx context.Context, channelID int64, sub db.PushSubscriptionForDispatch) {
	p256dh, err := decodePushBase64(sub.P256dh)
	if err != nil {
		d.failed.Add(1)
		return
	}
	authSecret, err := decodePushBase64(sub.Auth)
	if err != nil {
		d.failed.Add(1)
		return
	}
	body, err := encryptWebPushMessage(pushActivityPayload, p256dh, authSecret)
	if err != nil {
		d.failed.Add(1)
		return
	}
	authorization, err := d.push.vapidAuthorization(sub.Endpoint)
	if err != nil {
		d.failed.Add(1)
		return
	}
	req := safefetch.Request{
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
	}

	for attempt := 1; attempt <= pushMaxAttempts; attempt++ {
		if !d.stillEligible(ctx, channelID, sub.UserID) {
			return
		}
		resp, err := d.fetch.Fetch(ctx, req)
		if err == nil {
			switch {
			case resp.StatusCode == http.StatusCreated:
				d.dispatched.Add(1)
				return
			case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
				d.prune(ctx, sub.ID)
				return
			case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
				// transient -- fall through to the retry below
			default:
				d.failed.Add(1)
				return
			}
		}
		if attempt == pushMaxAttempts {
			d.failed.Add(1)
			return
		}
		d.sleep(ctx, pushRetryBackoffs[attempt-1])
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
