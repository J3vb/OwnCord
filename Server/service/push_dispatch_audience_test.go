package service

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// eligibilityCountingStore counts the per-user reads eligibleFor makes on a
// labelled channel.
type eligibilityCountingStore struct {
	Store
	acks atomic.Int32
}

func (s *eligibilityCountingStore) HasNSFWAcknowledgement(ctx context.Context, userID, channelID int64) (bool, error) {
	s.acks.Add(1)
	return s.Store.HasNSFWAcknowledgement(ctx, userID, channelID)
}

// TestPushDispatch_EligibilityOnlyForSubscribedUsers: a ping of a large role
// must not cost one permission read per holder. Of 40 candidates, 25 have no
// subscription, 5 are connected and 4 sit in a coalescing window; eligibility
// is read only for the remaining subscribed ones, after one listing.
func TestPushDispatch_EligibilityOnlyForSubscribedUsers(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "adults", Type: "text", NSFW: true})
	if _, err := f.database.ExecContext(context.Background(), `UPDATE channels SET nsfw = 1 WHERE id = 10`); err != nil {
		t.Fatalf("label channel: %v", err)
	}
	const author = int64(1)
	seedUserRole(t, f.database, author, 4)
	candidates := []int64{author}
	subscribed := map[int64]bool{}
	for uid := int64(2); uid <= 40; uid++ {
		seedUserRole(t, f.database, uid, 4)
		candidates = append(candidates, uid)
		if uid >= 26 { // 15 subscribed users: 26..40
			f.subscribe(t, uid, "https://push.example.net/u"+seedUsername(uid))
			subscribed[uid] = true
		}
	}
	online := func(uid int64) bool { return uid >= 26 && uid <= 30 } // 5 connected subscribers
	st := &eligibilityCountingStore{Store: f.database}
	d := NewPushDispatcher(st, f.perms, f.push, online, newRecordingPushFetcher())
	d.mu.Lock()
	for uid := int64(31); uid <= 34; uid++ { // 4 inside their window
		d.lastSent[pushCoalesceKey{uid, 10}] = time.Now()
	}
	d.mu.Unlock()

	d.Notify(context.Background(), 10, author, candidates)

	// 15 subscribed - 5 connected - 4 coalesced = 6 users reach the checks. The
	// count holds because no subscriber acknowledged the label, so all six fail
	// at eligibleFor.
	if got := st.acks.Load(); got != 6 {
		t.Errorf("eligibility reads = %d, want 6 (only subscribed, offline, uncoalesced users)", got)
	}
}

// A subscribed role holder who cannot read the channel is never pushed.
func TestPushDispatch_RoleHolderWhoCannotReadGetsNoPush(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "staff", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	seedUserRole(t, f.database, 3, 4)
	seedChannelOverride(t, f.database, 4, 10, 0, permissions.ReadMessages)
	if err := f.database.UpsertChannelUserOverride(context.Background(), 10, 3, permissions.ReadMessages, 0); err != nil {
		t.Fatal(err)
	}
	f.subscribe(t, 2, "https://push.example.net/cannot-read")
	f.subscribe(t, 3, "https://push.example.net/can-read")
	fetch := newRecordingPushFetcher()
	d := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)

	d.Notify(context.Background(), 10, 1, []int64{2, 3})

	if fetch.bodyFor("https://push.example.net/cannot-read") != nil {
		t.Error("holder who cannot read the channel was pushed")
	}
	if fetch.bodyFor("https://push.example.net/can-read") == nil {
		t.Error("holder with a user allow was not pushed")
	}
}

// Eligibility is checked before the coalescing window is reserved: an offline
// subscriber who cannot read the channel gets nothing and no window, so once
// granted access the next Notify delivers exactly once.
func TestPushDispatch_IneligibleSubscriberReservesNoWindow(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "staff", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	seedChannelOverride(t, f.database, 4, 10, 0, permissions.ReadMessages)
	f.subscribe(t, 2, "https://push.example.net/later")
	fetch := newRecordingPushFetcher()
	d := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)

	d.Notify(context.Background(), 10, 1, []int64{2})
	if len(fetch.urls()) != 0 {
		t.Fatalf("pushed to a user who cannot read: %v", fetch.urls())
	}
	if err := f.database.UpsertChannelUserOverride(context.Background(), 10, 2, permissions.ReadMessages, 0); err != nil {
		t.Fatal(err)
	}
	f.perms.InvalidateAll()
	d.Notify(context.Background(), 10, 1, []int64{2})
	if got := len(fetch.urls()); got != 1 {
		t.Errorf("pushes after access was granted = %d, want exactly 1", got)
	}
}
