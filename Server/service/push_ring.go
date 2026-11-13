package service

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// A DM call's ring reaches a phone whose app is closed or asleep as a push the phone rings from by itself,
// and the end of that ring (answered, declined, or the caller gave up) as a second push that takes it down.
// Both carry only the DM channel id: who calls is shown by the app once it opens, as for a message push.

// pushRingWindow is how long a ring is remembered for its end push: the push may sit up to its 30 s TTL at
// the push service and then ring 30 s on the phone, so a little past both.
const pushRingWindow = 65 * time.Second

// pushRingMapCap bounds the rings remembered; past it a new ring is still pushed but not remembered, so it
// rings out on the phone instead of being taken down early.
const pushRingMapCap = 10000

// pushRingHeaders: a ring is worth nothing once it has rung out, so a push service may drop it after 30 s,
// and high urgency asks it to wake a sleeping phone at once.
var pushRingHeaders = pushDelivery{ttl: "30", urgency: "high"}

// pushRingSendTimeout bounds one ring or ring-end delivery, retries included.
const pushRingSendTimeout = 15 * time.Second

// pushRingMaxAttempts: one retry, a second later; a ring retried any later would ring after the caller hung up.
const pushRingMaxAttempts = 2

const pushRingRetryBackoff = time.Second

// RingPush is one ring or ring-end push still to send: built under the ring book's lock, sent off it.
type RingPush struct {
	// End marks a ring-end push; false is the ring itself.
	End       bool
	ChannelID int64
	// CallerID is who rang: a ring is not delivered to a target who has blocked them since.
	CallerID int64
	UserIDs  []int64
}

// Empty reports whether there is nobody to push to.
func (p RingPush) Empty() bool { return len(p.UserIDs) == 0 }

// payload is the push body: the kind and the DM channel id, nothing else.
func (p RingPush) payload() []byte {
	kind := "ring"
	if p.End {
		kind = "ring_end"
	}
	return []byte(`{"t":"` + kind + `","c":` + strconv.FormatInt(p.ChannelID, 10) + `}`)
}

// pushRing is one remembered ring: who rang, who it still rings for, and until when.
type pushRing struct {
	caller  int64
	targets map[int64]bool
	until   time.Time
}

// pushRingBook remembers each DM's ring for its end push. In memory only: a restart forgets it, and a ring
// then rings out on the phone.
type pushRingBook struct {
	mu   syncutil.Mutex
	live map[int64]*pushRing
	now  func() time.Time
}

func (b *pushRingBook) clock() time.Time {
	if b.now != nil {
		return b.now()
	}
	return time.Now()
}

// liveLocked returns channelID's ring if it has not rung out, dropping it if it has. b.mu held.
func (b *pushRingBook) liveLocked(channelID int64, now time.Time) *pushRing {
	r, ok := b.live[channelID]
	if !ok {
		return nil
	}
	if !now.Before(r.until) {
		delete(b.live, channelID)
		return nil
	}
	return r
}

func (b *pushRingBook) expireLocked(now time.Time) {
	for ch, r := range b.live {
		if !now.Before(r.until) {
			delete(b.live, ch)
		}
	}
}

// RingStarted remembers callerID's ring in channelID for targets and returns the ring push. A ring again
// starts its time over.
func (d *PushDispatcher) RingStarted(channelID, callerID int64, targets []int64) RingPush {
	if len(targets) == 0 {
		return RingPush{}
	}
	b := &d.rings
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.clock()
	if _, ok := b.live[channelID]; !ok {
		b.expireLocked(now)
	}
	if _, ok := b.live[channelID]; ok || len(b.live) < pushRingMapCap {
		set := make(map[int64]bool, len(targets))
		for _, t := range targets {
			set[t] = true
		}
		b.live[channelID] = &pushRing{caller: callerID, targets: set, until: now.Add(pushRingWindow)}
	}
	return RingPush{ChannelID: channelID, CallerID: callerID, UserIDs: append([]int64(nil), targets...)}
}

// RingAnswered is userID declining the ring in channelID, or joining its call on any device: their phone
// stops ringing. Nothing to send when userID is not being rung there.
func (d *PushDispatcher) RingAnswered(channelID, userID int64) RingPush {
	b := &d.rings
	b.mu.Lock()
	defer b.mu.Unlock()
	r := b.liveLocked(channelID, b.clock())
	if r == nil || !r.targets[userID] {
		return RingPush{}
	}
	delete(r.targets, userID)
	if len(r.targets) == 0 {
		delete(b.live, channelID)
	}
	return RingPush{End: true, ChannelID: channelID, CallerID: r.caller, UserIDs: []int64{userID}}
}

// RingLeft is userID leaving channelID's call: when they rang it, every phone still ringing stops.
func (d *PushDispatcher) RingLeft(channelID, userID int64) RingPush {
	b := &d.rings
	b.mu.Lock()
	defer b.mu.Unlock()
	r := b.liveLocked(channelID, b.clock())
	if r == nil || r.caller != userID {
		return RingPush{}
	}
	delete(b.live, channelID)
	ids := make([]int64, 0, len(r.targets))
	for uid := range r.targets {
		ids = append(ids, uid)
	}
	return RingPush{End: true, ChannelID: channelID, CallerID: userID, UserIDs: ids}
}

// ringing reports whether channelID's ring still rings for userID, so a retry never rings after an answer.
func (d *PushDispatcher) ringing(channelID, userID int64) bool {
	b := &d.rings
	b.mu.Lock()
	defer b.mu.Unlock()
	r := b.liveLocked(channelID, b.clock())
	return r != nil && r.targets[userID]
}

// SendRing delivers p to every push subscription of its users, whether or not they look online: a phone
// whose app sleeps keeps no connection, and one whose app is open ignores the push. A ring skips users on
// Do Not Disturb, which promises no call popup. Never errors: failures are counted.
func (d *PushDispatcher) SendRing(ctx context.Context, p RingPush) {
	if p.Empty() {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, pushRingSendTimeout)
	defer cancel()

	userIDs := p.UserIDs
	if !p.End {
		userIDs = d.ringAudience(ctx, userIDs)
		if len(userIDs) == 0 {
			return
		}
	}
	subs, err := d.st.ListPushSubscriptionsForDispatch(ctx, userIDs, d.push.currentKeyID())
	if err != nil {
		slog.Error("PushDispatcher.SendRing ListPushSubscriptionsForDispatch", "err", err, "channel_id", p.ChannelID)
		return
	}
	payload := p.payload()
	items := make([]pushRoundItem, 0, len(subs))
	for _, sub := range subs {
		if req, ok := d.prepareRequest(sub, payload, pushRingHeaders); ok {
			items = append(items, pushRoundItem{sub: sub, req: req})
		}
	}
	for attempt := 1; attempt <= pushRingMaxAttempts && len(items) > 0; attempt++ {
		if attempt > 1 {
			d.sleep(ctx, pushRingRetryBackoff)
		}
		items = d.runRound(items, func(item pushRoundItem) bool {
			return d.attemptRing(ctx, p, item, attempt)
		})
	}
}

// ringAudience drops the users on Do Not Disturb (the status they chose stays stored while they are away).
// Fails closed: a user whose status cannot be read is not rung.
func (d *PushDispatcher) ringAudience(ctx context.Context, userIDs []int64) []int64 {
	out := make([]int64, 0, len(userIDs))
	for _, uid := range userIDs {
		u, err := d.st.GetUserByID(ctx, uid)
		if err != nil || u == nil || u.Status == db.StatusDND {
			continue
		}
		out = append(out, uid)
	}
	return out
}

// attemptRing re-checks, before every attempt, that the subscription is the one the request was built for
// and, for a ring, that it still rings for this user and they have not blocked the caller since.
func (d *PushDispatcher) attemptRing(ctx context.Context, p RingPush, item pushRoundItem, attempt int) bool {
	if !d.subscriptionStillCurrent(ctx, item) {
		return false
	}
	if !p.End && (!d.ringing(p.ChannelID, item.sub.UserID) || d.recipientBlocksAuthor(ctx, item.sub.UserID, p.CallerID)) {
		return false
	}
	return d.deliver(ctx, item, attempt == pushRingMaxAttempts)
}
