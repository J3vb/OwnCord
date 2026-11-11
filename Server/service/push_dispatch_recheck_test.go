package service

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/safefetch"
)

// TestPushDispatch_RecheckBeforeEachAttempt_NSFWAckRevoked is the NSFW half
// of TestPushDispatch_RecheckBeforeEachAttempt_TrustRevoked: a recipient who
// revokes their acknowledgement between the first (transiently failing)
// attempt and the retry gets no retry — stillEligible's per-attempt
// eligibleFor call re-resolves NSFWAcknowledged live, so it is not trusted
// from the round's start.
func TestPushDispatch_RecheckBeforeEachAttempt_NSFWAckRevoked(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedLabelledChannel(t)
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	if _, err := f.database.AcknowledgeNSFW(context.Background(), 2, 10); err != nil {
		t.Fatalf("AcknowledgeNSFW: %v", err)
	}
	f.subscribe(t, 2, "https://push.example.net/nsfw-ack-revoked")

	fetch := newRecordingPushFetcher()
	calls := failFirstAttempt(t, fetch, "https://push.example.net/nsfw-ack-revoked", "after the acknowledgement was revoked", func(ctx context.Context) {
		// Revoke between the first attempt and the retry.
		mustDo(t, "RevokeNSFW", f.database.RevokeNSFW(ctx, 2, 10))
	})

	dispatcher := f.newRetryDispatcher(fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	requireRetryRefused(t, calls)
	requireCounters(t, dispatcher, 0, 0, 0, "")
}

// TestPushDispatch_RecheckBeforeEachAttempt_TrustRevoked is the trust half
// of TestPushDispatch_RecheckBeforeEachAttempt_LosesAccess: a recipient who
// stops trusting the author between the first (transiently failing) attempt
// and the retry — blocked, or their acceptance somehow undone — gets no
// retry.
func TestPushDispatch_RecheckBeforeEachAttempt_TrustRevoked(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedDirectMessage(t)
	mustDo(t, "TrustSender", f.database.TrustSender(context.Background(), 2, 1, "accepted"))
	f.subscribe(t, 2, "https://push.example.net/trust-revoked")

	fetch := newRecordingPushFetcher()
	calls := failFirstAttempt(t, fetch, "https://push.example.net/trust-revoked", "after trust was revoked", func(ctx context.Context) {
		// Revoke between the first attempt and the retry.
		if _, err := f.database.ExecContext(ctx,
			`DELETE FROM trusted_senders WHERE recipient_id = ? AND sender_id = ?`, int64(2), int64(1)); err != nil {
			t.Fatal(err)
		}
	})

	dispatcher := f.newRetryDispatcher(fetch)
	dispatcher.Notify(context.Background(), 20, 1, []int64{2})

	requireRetryRefused(t, calls)
	requireCounters(t, dispatcher, 0, 0, 0, "")
}

// TestPushDispatch_RecheckBeforeEachAttempt_ComesOnline is P1-1: a recipient
// who comes online between the first (transiently failing) attempt and the
// retry must receive nothing on the retry -- stillEligible has to run again
// immediately before every attempt, not just once for the whole dispatch.
func TestPushDispatch_RecheckBeforeEachAttempt_ComesOnline(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedGeneralChannel(t)
	f.subscribe(t, 2, "https://push.example.net/goes-online")

	var wentOnline atomic.Bool
	online := func(uid int64) bool { return uid == 2 && wentOnline.Load() }

	fetch := newRecordingPushFetcher()
	calls := failFirstAttempt(t, fetch, "https://push.example.net/goes-online", "after the recipient came online", func(ctx context.Context) {
		wentOnline.Store(true) // simulate: recipient connects right after the first attempt
	})

	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, online, fetch)
	dispatcher.sleep = noSleep
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	requireRetryRefused(t, calls)
	requireCounters(t, dispatcher, 0, 0, 0, "")
}

// TestPushDispatch_RecheckBeforeEachAttempt_LosesAccess is P1-1's other
// half: a recipient whose CanViewChannel is revoked between the first
// (transiently failing) attempt and the retry must receive nothing on the
// retry.
func TestPushDispatch_RecheckBeforeEachAttempt_LosesAccess(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedGeneralChannel(t)
	seedRole(t, f.database, &db.Role{ID: 5, Name: "Restricted", Permissions: 0, Position: 0})
	f.subscribe(t, 2, "https://push.example.net/loses-access")

	fetch := newRecordingPushFetcher()
	calls := failFirstAttempt(t, fetch, "https://push.example.net/loses-access", "after access was revoked", func(ctx context.Context) {
		// Revoke between the first attempt and the retry.
		mustDo(t, "UpdateUserRole", f.database.UpdateUserRole(ctx, 2, 5))
		f.perms.InvalidateAll()
	})

	dispatcher := f.newRetryDispatcher(fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	requireRetryRefused(t, calls)
	requireCounters(t, dispatcher, 0, 0, 0, "")
}

// ─── R3: revalidate the work before every attempt ───────────────────────────
//
// stillEligible already re-checked the recipient's own state (online,
// permission, NSFW consent, DM trust) before each attempt. These tests pin the
// two things it did NOT re-check: the block relation, and the subscription row
// the saved request was encrypted for. Both are snapshots Notify takes once,
// while the retry rounds can run five seconds later.

// isBlockedErrorStore overrides only IsBlocked to fail, for R3's fail-closed
// test -- the per-attempt counterpart of listBlockersErrorStore above.
type isBlockedErrorStore struct{ Store }

func (isBlockedErrorStore) IsBlocked(context.Context, int64, int64) (bool, error) {
	return false, errors.New("boom")
}

// subscriptionListingErrorStore serves Notify's audience listing normally and
// fails every later listing -- i.e. the per-attempt revalidation -- so a test
// can distinguish "no push happened because the audience was empty" from "no
// push happened because the revalidation could not be answered".
type subscriptionListingErrorStore struct {
	Store
	calls atomic.Int32
}

func (s *subscriptionListingErrorStore) ListPushSubscriptionsForDispatch(ctx context.Context, userIDs []int64, keyID string) ([]db.PushSubscriptionForDispatch, error) {
	if s.calls.Add(1) == 1 {
		return s.Store.ListPushSubscriptionsForDispatch(ctx, userIDs, keyID)
	}
	return nil, errors.New("boom")
}

// revokeAfterListingStore deletes every subscription for the user the moment
// Notify's audience listing returns -- the deterministic form of "the user
// revoked this device before the first attempt ran", which a saturated send
// pool can delay for a whole round.
type revokeAfterListingStore struct {
	Store
	database *db.DB
	calls    atomic.Int32
}

func (s *revokeAfterListingStore) ListPushSubscriptionsForDispatch(ctx context.Context, userIDs []int64, keyID string) ([]db.PushSubscriptionForDispatch, error) {
	subs, err := s.Store.ListPushSubscriptionsForDispatch(ctx, userIDs, keyID)
	if err != nil || s.calls.Add(1) != 1 {
		return subs, err
	}
	for _, uid := range userIDs {
		rows, lErr := s.database.ListPushSubscriptions(ctx, uid, keyID)
		if lErr != nil {
			return nil, lErr
		}
		for _, row := range rows {
			if _, dErr := s.database.DeletePushSubscription(ctx, uid, row.ID); dErr != nil {
				return nil, dErr
			}
		}
	}
	return subs, nil
}

// TestPushDispatch_RecheckBeforeEachAttempt_BlockedAfterFirst503 is R3's guild
// half. coalesceAudience reads the blocker set once, before the dispatch
// starts; a 503 costs a 1s backoff and a second round, and a recipient who
// blocks the author inside that window has withdrawn consent to be contacted.
// The whole set is not re-read per round, so this asks the one
// (recipient, author) pair instead -- see stillEligible.
func TestPushDispatch_RecheckBeforeEachAttempt_BlockedAfterFirst503(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedGeneralChannel(t)
	const endpoint = "https://push.example.net/block-after-503"
	f.subscribe(t, 2, endpoint)

	fetch := newRecordingPushFetcher()
	calls := failFirstAttempt(t, fetch, endpoint, "after the recipient blocked the author", func(ctx context.Context) {
		mustDo(t, "BlockUser", f.database.BlockUser(ctx, 2, 1))
	})

	dispatcher := f.newRetryDispatcher(fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	requireRetryRefused(t, calls)
	d, fl, p := dispatcher.Counters()
	if d != 0 || fl != 0 || p != 0 {
		t.Errorf("counters = %d/%d/%d, want 0/0/0: a refusal is not a delivery outcome", d, fl, p)
	}
}

// TestPushDispatch_RecheckBeforeEachAttempt_BlockedAfterFirst503_DM is the
// trusted-one-to-one-DM half of the same rule. The DM needs its own case
// because the audience filter there is participation PLUS trust, and
// trustsAuthor re-checks only the trust half -- a block is a separate relation
// and would otherwise ride through on a still-valid trusted_senders row.
func TestPushDispatch_RecheckBeforeEachAttempt_BlockedAfterFirst503_DM(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedDirectMessage(t)
	mustDo(t, "TrustSender", f.database.TrustSender(context.Background(), 2, 1, "accepted"))
	const endpoint = "https://push.example.net/dm-block-after-503"
	f.subscribe(t, 2, endpoint)

	fetch := newRecordingPushFetcher()
	calls := failFirstAttempt(t, fetch, endpoint, "after the recipient blocked the author in a DM", func(ctx context.Context) {
		mustDo(t, "BlockUser", f.database.BlockUser(ctx, 2, 1))
	})

	dispatcher := f.newRetryDispatcher(fetch)
	dispatcher.Notify(context.Background(), 20, 1, []int64{2})

	requireRetryRefused(t, calls)
}

// TestPushDispatch_RecheckBeforeEachAttempt_SubscriptionRevoked is R3's
// subscription half, and asserts it per subscription: the revoked device is
// refused its retry while the user's OTHER device, untouched by the
// revocation, still receives its notification. A guard that keyed off the
// user rather than the row would pass the first half and fail this one.
func TestPushDispatch_RecheckBeforeEachAttempt_SubscriptionRevoked(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedGeneralChannel(t)
	const revoked = "https://push.example.net/revoked-device"
	const kept = "https://push.example.net/kept-device"
	f.subscribe(t, 2, revoked)
	f.subscribe(t, 2, kept)

	fetch := newRecordingPushFetcher()
	var revokedCalls atomic.Int32
	fetch.onFetch(revoked, func(ctx context.Context) (*safefetch.Response, error) {
		if revokedCalls.Add(1) > 1 {
			t.Error("the revoked device's endpoint was fetched again on the retry")
			return &safefetch.Response{StatusCode: 201}, nil
		}
		rows, err := f.database.ListPushSubscriptions(ctx, 2, f.keyID)
		mustDo(t, "ListPushSubscriptions", err)
		for _, row := range rows {
			if row.Endpoint != revoked {
				continue
			}
			if _, err := f.database.DeletePushSubscription(ctx, 2, row.ID); err != nil {
				t.Fatal(err)
			}
		}
		return &safefetch.Response{StatusCode: 503}, nil
	})
	fetch.always(kept, 201)

	dispatcher := f.newRetryDispatcher(fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if got := revokedCalls.Load(); got != 1 {
		t.Errorf("revoked device fetched %d times, want exactly 1", got)
	}
	if got := fetch.countFor(kept); got != 1 {
		t.Errorf("the user's other device was fetched %d times, want 1: revoking one subscription must not silence the rest", got)
	}
	if d, _, _ := dispatcher.Counters(); d != 1 {
		t.Errorf("dispatched = %d, want 1 (the surviving device's success)", d)
	}
}

// TestPushDispatch_RecheckBeforeEachAttempt_CredentialRotated covers the row
// that is still there but no longer the subscription the request was built
// for. Re-subscribing the same endpoint refreshes the credential in place
// (UpsertPushSubscription's ON CONFLICT), so the row id is unchanged and only
// an id check would wave this through -- re-sending bytes encrypted to a key
// the device has already replaced.
func TestPushDispatch_RecheckBeforeEachAttempt_CredentialRotated(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedGeneralChannel(t)
	const endpoint = "https://push.example.net/credential-rotated"
	f.subscribe(t, 2, endpoint)

	replacement := newPushTestSubscriber(t)
	fetch := newRecordingPushFetcher()
	var calls atomic.Int32
	fetch.onFetch(endpoint, func(ctx context.Context) (*safefetch.Response, error) {
		if calls.Add(1) > 1 {
			t.Error("a second attempt re-sent a request encrypted to the replaced credential")
			return &safefetch.Response{StatusCode: 201}, nil
		}
		if _, err := f.database.UpsertPushSubscription(ctx, 2, endpoint,
			replacement.p256dhB64, replacement.authB64, "d2", f.keyID, 10); err != nil {
			t.Fatal(err)
		}
		return &safefetch.Response{StatusCode: 503}, nil
	})

	dispatcher := f.newRetryDispatcher(fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	requireRetryRefused(t, &calls)
}

// TestPushDispatch_RecheckBeforeEachAttempt_VAPIDKeyRotated: a row the running
// key can no longer sign for is not one dispatch may send to. The listing
// filters on the running key id, so after a rotation the row the request was
// built from stops appearing at all -- the same miss as a deletion, and the
// revalidation must read it that way rather than falling back to "not found,
// so carry on".
func TestPushDispatch_RecheckBeforeEachAttempt_VAPIDKeyRotated(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedGeneralChannel(t)
	const endpoint = "https://push.example.net/key-rotated"
	f.subscribe(t, 2, endpoint)

	fetch := newRecordingPushFetcher()
	var calls atomic.Int32
	fetch.onFetch(endpoint, func(ctx context.Context) (*safefetch.Response, error) {
		if calls.Add(1) > 1 {
			t.Error("a second attempt was signed for a rotated-away VAPID key")
			return &safefetch.Response{StatusCode: 201}, nil
		}
		// Rotate the server's key between the first attempt and the retry.
		f.push.SetVAPIDKey(genTestVAPIDKey(t))
		return &safefetch.Response{StatusCode: 503}, nil
	})

	dispatcher := f.newRetryDispatcher(fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	requireRetryRefused(t, &calls)
}

// TestPushDispatch_RecheckBeforeEachAttempt_BlockLookupFailureFailsClosed: a
// per-attempt block check that cannot be answered must not fetch. The
// whole-round ListBlockersOf failure is already covered by
// TestPushDispatch_BlockerLookupFailureFailsClosed; this is the same posture
// for the narrow per-pair lookup.
func TestPushDispatch_RecheckBeforeEachAttempt_BlockLookupFailureFailsClosed(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedGeneralChannel(t)
	f.subscribe(t, 2, "https://push.example.net/per-attempt-block-error")

	fetch := newRecordingPushFetcher()
	dispatcher := NewPushDispatcher(isBlockedErrorStore{f.database}, f.perms, f.push, nil, fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if urls := fetch.urls(); len(urls) != 0 {
		t.Errorf("fetch calls = %v, want none: an unanswerable block check must fail closed", urls)
	}
}

// TestPushDispatch_RecheckBeforeEachAttempt_SubscriptionLookupFailureFailsClosed:
// same posture for the subscription revalidation -- an unresolvable row is
// never permission to re-send the saved request.
func TestPushDispatch_RecheckBeforeEachAttempt_SubscriptionLookupFailureFailsClosed(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedGeneralChannel(t)
	f.subscribe(t, 2, "https://push.example.net/per-attempt-sub-error")

	fetch := newRecordingPushFetcher()
	st := &subscriptionListingErrorStore{Store: f.database}
	dispatcher := NewPushDispatcher(st, f.perms, f.push, nil, fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if urls := fetch.urls(); len(urls) != 0 {
		t.Errorf("fetch calls = %v, want none: an unanswerable subscription check must fail closed", urls)
	}
	if st.calls.Load() < 2 {
		t.Errorf("subscription listing ran %d times, want at least 2 (Notify's audience plus one revalidation)", st.calls.Load())
	}
}

// TestPushDispatch_RecheckBeforeEachAttempt_RevokedBeforeFirstAttempt: the
// first attempt is not exempt. Nothing has been sent yet, so a subscription
// revoked between the audience listing and the first fetch must produce zero
// fetches, not one -- a worker pool that is already saturated can hold that
// first attempt for a whole round.
func TestPushDispatch_RecheckBeforeEachAttempt_RevokedBeforeFirstAttempt(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedGeneralChannel(t)
	f.subscribe(t, 2, "https://push.example.net/revoked-before-first-attempt")

	fetch := newRecordingPushFetcher()
	dispatcher := NewPushDispatcher(&revokeAfterListingStore{Store: f.database, database: f.database}, f.perms, f.push, nil, fetch)
	dispatcher.sleep = noSleep
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if urls := fetch.urls(); len(urls) != 0 {
		t.Errorf("fetch calls = %v, want none: the subscription was already revoked", urls)
	}
}

// TestPushDispatch_RecheckBeforeEachAttempt_ValidWorkStillRetries is the
// no-false-negative guard for the two checks above: a subscription and a block
// relation that have NOT changed must still get the ordinary bounded retry.
// Without this, refusing every retry would satisfy every test above.
func TestPushDispatch_RecheckBeforeEachAttempt_ValidWorkStillRetries(t *testing.T) {
	f := newPushDispatchFixture(t)
	f.seedGeneralChannel(t)
	const endpoint = "https://push.example.net/unchanged-still-retries"
	f.subscribe(t, 2, endpoint)

	fetch := newRecordingPushFetcher()
	fetch.sequence(endpoint,
		pushFetchResult{status: 503},
		pushFetchResult{status: 503},
		pushFetchResult{status: 201},
	)

	dispatcher := f.newRetryDispatcher(fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if got := fetch.countFor(endpoint); got != 3 {
		t.Errorf("fetch called %d times, want 3: an unchanged subscription must still get its full retry budget", got)
	}
	requireCounters(t, dispatcher, 1, 0, 0, "")
}
