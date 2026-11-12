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

// pushActivityPayload is the ONLY payload dispatch sends: no text, channel, sender or count.
var pushActivityPayload = []byte(`{"t":"activity"}`)

// pushCoalesceWindow bounds how often one user is pushed about one channel (in memory; a restart forgets it).
const pushCoalesceWindow = 60 * time.Second

// pushCoalesceMapCap bounds coalescer memory; past it a new pair is refused rather than evicting one, which
// would be pushed again early.
const pushCoalesceMapCap = 10000

const pushDispatchTimeout = 60 * time.Second

// pushMaxConcurrentSends bounds concurrent deliveries per round, within pushFetcher's MaxConcurrent (8).
const pushMaxConcurrentSends = 4

const pushMaxAttempts = 3

// pushRetryBackoffs is the backoff between rounds (1s, 4s, 16s); only the first two are used.
var pushRetryBackoffs = []time.Duration{time.Second, 4 * time.Second, 16 * time.Second}

// PushNotifier is installed on MessageService when dispatch is on; nil means off and SendMessage skips the
// hook.
type PushNotifier interface {
	// Notify considers a generic-content push for a message; candidateIDs is the caller's pre-narrowed seed. It
	// never errors: failures are counted.
	Notify(ctx context.Context, channelID, authorID int64, candidateIDs []int64)
}

// PushFetcher is the safefetch surface dispatch needs: *safefetch.Fetcher in production, a stub in tests.
type PushFetcher interface {
	Fetch(ctx context.Context, req safefetch.Request) (*safefetch.Response, error)
}

// pushPolicy is dispatch's safefetch.Policy: https/443 only, no redirects, small deadline and byte ceiling. A
// function so a test can swap one seam (TestProductionPolicyShape still sees the literal).
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

var pushFetcher = safefetch.MustNew(pushPolicy())

type pushCoalesceKey struct {
	userID    int64
	channelID int64
}

// pushRoundItem is one subscription's state between rounds: the request is built once and re-sent unchanged,
// which is safe only because subscriptionStillCurrent re-reads the row before every attempt.
type pushRoundItem struct {
	sub db.PushSubscriptionForDispatch
	req safefetch.Request
}

type pushDispatchStore interface {
	subjectStore
	ListBlockersOf(ctx context.Context, blockedID int64) ([]int64, error)
	// IsBlocked answers one (blocker, blocked) pair; dispatch re-asks it before every attempt, since a block
	// landing in flight must stop the remaining attempts.
	IsBlocked(ctx context.Context, blockerID, blockedID int64) (bool, error)
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	IsTrustedSender(ctx context.Context, recipientID, senderID int64) (bool, error)
	ListPushSubscriptionsForDispatch(ctx context.Context, userIDs []int64, keyID string) ([]db.PushSubscriptionForDispatch, error)
	DeletePushSubscriptionByID(ctx context.Context, id int64) (bool, error)
}

// PushDispatcher is the composition root's PushNotifier: audience, coalescing, encryption, sending, retries,
// pruning and counters. Built only when push.enabled and push.dispatch_enabled are true.
type PushDispatcher struct {
	st     pushDispatchStore
	perms  *PermissionService
	push   *PushService
	online func(userID int64) bool
	fetch  PushFetcher
	// sleep backs the retry backoff; a test seam, cancellable by ctx.
	sleep func(ctx context.Context, d time.Duration)

	mu       syncutil.Mutex
	lastSent map[pushCoalesceKey]time.Time

	dispatched atomic.Uint64
	failed     atomic.Uint64
	pruned     atomic.Uint64
}

// NewPushDispatcher constructs a PushDispatcher. fetch is nil in production (the shared pushFetcher).
func NewPushDispatcher(st pushDispatchStore, perms *PermissionService, push *PushService, online func(int64) bool, fetch PushFetcher) *PushDispatcher {
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

// Counters reports the aggregate push_dispatched, push_failed, push_pruned counts, never per user.
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
	// A labelled channel still pushes to a recipient who acknowledged the label (eligibleFor, via
	// CanReadContent). Only one-to-one DMs are in scope and a group DM is also Type == "dm". Fail closed: a
	// lookup error counts as a group.
	if ch.Type == "dm" {
		isGroup, gErr := d.st.IsGroupDM(ctx, channelID)
		if gErr != nil || isGroup {
			return
		}
	}

	// A user who blocked the author must never be pushed about their message; fail closed on a lookup failure.
	blockers, err := d.st.ListBlockersOf(ctx, authorID)
	if err != nil {
		slog.Error("PushDispatcher.Notify ListBlockersOf", "err", err, "user_id", authorID)
		return
	}
	blockedByAuthor := make(map[int64]bool, len(blockers))
	for _, b := range blockers {
		blockedByAuthor[b] = true
	}

	// Cheapest in-memory filters first, then per-user permission and trust reads only for subscribed users.
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

	// Reserve the coalescing window only once a user has a prepared request, so a missing subscription or failed
	// lookup never suppresses a later mention; the loser of a concurrent Notify drops its items (no double
	// send).
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

	// Round-based delivery: every item's Nth attempt runs before any item's (N+1)th, so slow endpoints cannot
	// hold pool slots through every retry and starve first attempts.
	for attempt := 1; attempt <= pushMaxAttempts && len(items) > 0; attempt++ {
		if attempt > 1 {
			d.sleep(ctx, pushRetryBackoffs[attempt-2])
		}
		items = d.runRound(ctx, channelID, authorID, items, attempt)
	}
}

// runRound performs attempt (1-based) for every item and returns the items to retry.
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

// prepareRequest builds the fixed, never re-encrypted request once; a failure is terminal (counted failed,
// never retried).
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

// attemptOne performs one delivery attempt, re-checking eligibility first, and reports whether to retry;
// every terminal outcome lands in exactly one counter.
func (d *PushDispatcher) attemptOne(ctx context.Context, channelID, authorID int64, item pushRoundItem, attempt int) bool {
	// Subscription first, then eligibility: this makes the saved, never re-encrypted item.req safe to re-send.
	// Both run before every fetch, so a revocation or block anywhere in the dispatch's lifetime stops the work.
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

// trustsAuthor reports whether a 1:1 DM push to uid may proceed: always true outside a "dm" channel, else the
// trusted_senders lookup. Fails closed.
func (d *PushDispatcher) trustsAuthor(ctx context.Context, ch *db.Channel, uid, authorID int64) bool {
	if ch.Type != "dm" {
		return true
	}
	trusted, err := d.st.IsTrustedSender(ctx, uid, authorID)
	return err == nil && trusted
}

// eligibleFor reports whether userID may be pushed to for ch now: not connected, and permitted to READ ch's
// content via permissions.CanReadContent (a labelled channel gets no push to a viewer who has not
// acknowledged it). Fails closed. ch is the caller's resolved channel; use stillEligible when it must be
// re-fetched.
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

// stillEligible re-resolves, just before each attempt, what can change in flight: the recipient blocked the
// author, came online, lost CanViewChannel or the label/acknowledgement changed, or (1:1 DM) no longer trusts
// the author. The block is re-asked PER ATTEMPT because the audience's blockers map is a snapshot and a
// dispatch spans several rounds; a block withdraws consent to be contacted, so retries must not fire.
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

// recentlySent is the read-only half of coalesced: inside an open window for channelID, without starting one.
func (d *PushDispatcher) recentlySent(userID, channelID int64, now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	last, ok := d.lastSent[pushCoalesceKey{userID, channelID}]
	return ok && now.Sub(last) < pushCoalesceWindow
}

// coalesced reports whether userID was already pushed about channelID within pushCoalesceWindow; if not, it
// starts a window. At capacity the new pair is refused (reported coalesced) rather than evicting an active
// window.
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
