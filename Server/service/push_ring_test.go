package service

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// ringDispatcher is a dispatcher whose every user looks online: a ring push must reach them anyway.
func (f *pushDispatchFixture) ringDispatcher(fetch PushFetcher) *PushDispatcher {
	d := NewPushDispatcher(f.database, f.perms, f.push, func(int64) bool { return true }, fetch)
	d.sleep = noSleep
	return d
}

func requireRingPush(t *testing.T, got RingPush, end bool, channelID int64, userIDs ...int64) {
	t.Helper()
	ids := slices.Clone(got.UserIDs)
	slices.Sort(ids)
	if got.End != end || got.ChannelID != channelID || !slices.Equal(ids, userIDs) {
		t.Errorf("push = %+v, want end=%v channel=%d users=%v", got, end, channelID, userIDs)
	}
}

func TestRingPush_RingAndEndCarryOnlyTheChannelAndWakeThePhone(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedDirectMessage(t)
	const endpoint = "https://push.example.net/ring"
	sub := f.subscribe(t, 2, endpoint)
	fetch := newRecordingPushFetcher()
	d := f.ringDispatcher(fetch)

	d.SendRing(context.Background(), d.RingStarted(20, 1, []int64{2}))
	d.SendRing(context.Background(), d.RingAnswered(20, 2))

	fetch.mu.Lock()
	calls := slices.Clone(fetch.calls)
	fetch.mu.Unlock()
	if len(calls) != 2 {
		t.Fatalf("fetch calls = %d, want the ring and its end even though the user looks online", len(calls))
	}
	for i, want := range []string{`{"t":"ring","c":20}`, `{"t":"ring_end","c":20}`} {
		if got := string(sub.decrypt(t, calls[i].Body)); got != want {
			t.Errorf("payload %d = %s, want %s", i, got, want)
		}
		if calls[i].Header["TTL"] != "30" || calls[i].Header["Urgency"] != "high" {
			t.Errorf("headers %d = %v, want TTL 30 and Urgency high", i, calls[i].Header)
		}
	}
	requireCounters(t, d, 2, 0, 0, "")
	if fetch.countFor(endpoint) != 2 {
		t.Errorf("endpoint reached %d times, want 2", fetch.countFor(endpoint))
	}
}

func TestRingPush_BookFollowsAnswersAndTheCaller(t *testing.T) {
	f := newPushDispatchFixture(t)
	d := f.ringDispatcher(newRecordingPushFetcher())

	requireRingPush(t, d.RingStarted(20, 1, []int64{2, 3, 4}), false, 20, 2, 3, 4)
	requireRingPush(t, d.RingAnswered(20, 2), true, 20, 2)
	requireRingPush(t, d.RingAnswered(20, 2), false, 0)
	requireRingPush(t, d.RingAnswered(20, 1), false, 0)
	requireRingPush(t, d.RingLeft(20, 3), false, 0)
	requireRingPush(t, d.RingLeft(20, 1), true, 20, 3, 4)
	requireRingPush(t, d.RingLeft(20, 1), false, 0)
	requireRingPush(t, d.RingStarted(21, 1, nil), false, 0)
	requireRingPush(t, d.RingAnswered(21, 2), false, 0)
}

func TestRingPush_RungOutRingSendsNoEnd(t *testing.T) {
	f := newPushDispatchFixture(t)
	d := f.ringDispatcher(newRecordingPushFetcher())
	now := time.Unix(1_000_000, 0)
	d.rings.now = func() time.Time { return now }

	d.RingStarted(20, 1, []int64{2})
	now = now.Add(pushRingWindow)
	requireRingPush(t, d.RingAnswered(20, 2), false, 0)
	if len(d.rings.live) != 0 {
		t.Errorf("rings remembered = %d, want the rung-out ring dropped", len(d.rings.live))
	}
}

func TestRingPush_FullBookStillRingsButRemembersNothingNew(t *testing.T) {
	f := newPushDispatchFixture(t)
	d := f.ringDispatcher(newRecordingPushFetcher())
	for ch := range int64(pushRingMapCap) {
		d.RingStarted(ch+1000, 1, []int64{2})
	}
	requireRingPush(t, d.RingStarted(20, 1, []int64{2}), false, 20, 2)
	requireRingPush(t, d.RingAnswered(20, 2), false, 0)
	requireRingPush(t, d.RingStarted(1000, 1, []int64{3}), false, 1000, 3)
	requireRingPush(t, d.RingAnswered(1000, 3), true, 1000, 3)
}

func TestRingPush_DoNotDisturbGetsNoRingButItsEnd(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedDirectMessage(t)
	const endpoint = "https://push.example.net/dnd"
	f.subscribe(t, 2, endpoint)
	mustDo(t, "UpdateUserStatus", f.database.UpdateUserStatus(context.Background(), 2, db.StatusDND))
	fetch := newRecordingPushFetcher()
	d := f.ringDispatcher(fetch)

	d.SendRing(context.Background(), d.RingStarted(20, 1, []int64{2}))
	if n := fetch.countFor(endpoint); n != 0 {
		t.Fatalf("ring reached a Do Not Disturb user %d times", n)
	}
	d.SendRing(context.Background(), d.RingAnswered(20, 2))
	if n := fetch.countFor(endpoint); n != 1 {
		t.Errorf("ring end reached the user %d times, want 1: taking a ring down is always safe", n)
	}
}

func TestRingPush_RetryStopsOnceAnswered(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedDirectMessage(t)
	const endpoint = "https://push.example.net/answered"
	f.subscribe(t, 2, endpoint)
	fetch := newRecordingPushFetcher()
	d := f.ringDispatcher(fetch)
	calls := failFirstAttempt(t, fetch, endpoint, "after the callee answered", func(context.Context) {
		d.RingAnswered(20, 2)
	})

	d.SendRing(context.Background(), d.RingStarted(20, 1, []int64{2}))
	requireRetryRefused(t, calls)
}

func TestRingPush_RetryStopsOnceCallerBlocked(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedDirectMessage(t)
	const endpoint = "https://push.example.net/blocked"
	f.subscribe(t, 2, endpoint)
	fetch := newRecordingPushFetcher()
	d := f.ringDispatcher(fetch)
	calls := failFirstAttempt(t, fetch, endpoint, "after the callee blocked the caller", func(ctx context.Context) {
		mustDo(t, "BlockUser", f.database.BlockUser(ctx, 2, 1))
	})

	d.SendRing(context.Background(), d.RingStarted(20, 1, []int64{2}))
	requireRetryRefused(t, calls)
}

func TestRingPush_LastFailedAttemptIsCounted(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedDirectMessage(t)
	const endpoint = "https://push.example.net/down"
	f.subscribe(t, 2, endpoint)
	fetch := newRecordingPushFetcher()
	fetch.always(endpoint, 503)
	d := f.ringDispatcher(fetch)

	d.SendRing(context.Background(), d.RingStarted(20, 1, []int64{2}))
	if n := fetch.countFor(endpoint); n != pushRingMaxAttempts {
		t.Errorf("attempts = %d, want %d", n, pushRingMaxAttempts)
	}
	requireCounters(t, d, 0, 1, 0, "(the last 503 is a failure)")
}
