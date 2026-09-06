package service

import (
	"context"
	"log/slog"
	"net/http"
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

// pushDispatchTimeout bounds one Notify call end to end: the channel and
// permission lookups, every subscriber's subscriptions, and every attempt
// (including retries) against every one of them. It is generous rather than
// tight because a push is a hint with no caller waiting on it -- the request
// that triggered it has already returned.
//
// ponytail: subscribers are dispatched to sequentially inside one deadline,
// not fanned out concurrently. Fine at self-hosted scale (a handful of
// push-subscribed recipients per event); switch to a bounded worker pool if
// a single channel ever has enough subscribers that 60s is not enough.
const pushDispatchTimeout = 60 * time.Second

// pushMaxAttempts is the retry budget for one subscription: the initial
// attempt plus two retries, backing off by pushRetryBackoffs between them.
const pushMaxAttempts = 3

// pushRetryBackoffs is the backoff schedule between attempts. Only the first
// two entries are ever used -- pushMaxAttempts caps the loop at 3 attempts,
// which needs 2 waits -- the third is kept so the schedule reads as the
// intended exponential curve (1s, 4s, 16s) rather than stopping short of it
// by coincidence.
var pushRetryBackoffs = []time.Duration{time.Second, 4 * time.Second, 16 * time.Second}

// PushNotifier is installed on MessageService when dispatch is on; nil
// means dispatch is off (either push.enabled or push.dispatch_enabled is
// false), and MessageService.SendMessage skips the hook entirely.
type PushNotifier interface {
	// Notify considers dispatching a generic-content push for a message
	// authored by authorID in channelID. candidateIDs is the caller's
	// pre-narrowed audience seed: the message's direct @mentions for a
	// guild channel, or the DM's participant ids for a DM -- Notify applies
	// every remaining filter (author, online, permission, NSFW label,
	// coalescing) itself. It never returns an error; failures are counted,
	// not surfaced to the send path a user is waiting on.
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
	// no push at all for a labelled channel.
	if ch.NSFW {
		return
	}

	eligible := d.eligibleAudience(ctx, ch, authorID, candidateIDs)
	if len(eligible) == 0 {
		return
	}

	keyID := d.push.currentKeyID()
	subs, err := d.st.ListPushSubscriptionsForDispatch(ctx, eligible, keyID)
	if err != nil {
		slog.Error("PushDispatcher.Notify ListPushSubscriptionsForDispatch", "err", err, "channel_id", channelID)
		return
	}
	for _, sub := range subs {
		d.sendOne(ctx, sub)
	}
}

// eligibleAudience narrows candidateIDs to the users dispatch may push to:
// distinct, not the author, not currently connected (online), permitted to
// view ch right now, and not inside their coalescing window for ch. The
// coalescing window starts the instant a user clears every other check --
// whether or not they turn out to have a subscription -- so a user with zero
// devices does not get re-evaluated on every message in a busy channel
// either.
//
// For a DM, permission IS participation (permissions.CanViewChannel checks
// only DMParticipant for a "dm" channel), so a non-participant candidate is
// already excluded here. B5-6: trusted_senders does not exist on this
// branch (B5-6 is behind HP-5 too and may not have merged yet). Once it
// does, a DM push should also require that the recipient trusts the
// sender -- the same row Message Requests gates on -- so a first-contact
// message from an unknown sender cannot ring a stranger's phone before
// they have decided to accept it.
func (d *PushDispatcher) eligibleAudience(ctx context.Context, ch *db.Channel, authorID int64, candidateIDs []int64) []int64 {
	seen := make(map[int64]bool, len(candidateIDs))
	out := make([]int64, 0, len(candidateIDs))
	now := time.Now()
	for _, uid := range candidateIDs {
		if uid == authorID || uid <= 0 || seen[uid] {
			continue
		}
		seen[uid] = true
		if d.online != nil && d.online(uid) {
			continue
		}
		sub, err := channelSubject(ctx, d.st, d.perms, uid, ch, false)
		if err != nil {
			continue
		}
		if permissions.CanViewChannel(sub) != nil {
			continue
		}
		if d.coalesced(uid, ch.ID, now) {
			continue
		}
		out = append(out, uid)
	}
	return out
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
	d.lastSent[key] = now
	return false
}

// sendOne encrypts and POSTs one push to one subscription, retrying a
// transient failure within pushMaxAttempts. It never returns an error;
// every outcome lands in exactly one counter.
func (d *PushDispatcher) sendOne(ctx context.Context, sub db.PushSubscriptionForDispatch) {
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
