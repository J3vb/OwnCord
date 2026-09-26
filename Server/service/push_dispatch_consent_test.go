package service

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/safefetch"
)

// ─── B5 Condition 6: withdrawn authority never reaches a later attempt ──────
//
// The R3 tests in push_dispatch_test.go pin each per-attempt recheck on its
// own, withdrawing through raw DB writes at a single boundary. This file
// is the Condition 6 proof: the withdrawal goes through the services a user
// actually reaches (PushService.Revoke, BlockService.BlockUser), the message
// goes through the real SendMessage hook, and the withdrawal lands at EVERY
// point a delivery can still be pending -- queued before its first attempt,
// and between each pair of retries -- with an untouched recipient in the same
// dispatch proving the refusal is scoped to the one who withdrew.

// afterAudienceListingStore runs hook once, the moment Notify's audience
// listing returns and before any attempt -- the deterministic form of "the
// withdrawal landed while the delivery was still queued".
type afterAudienceListingStore struct {
	Store
	hook  func(ctx context.Context)
	calls atomic.Int32
}

func (s *afterAudienceListingStore) ListPushSubscriptionsForDispatch(ctx context.Context, userIDs []int64, keyID string) ([]db.PushSubscriptionForDispatch, error) {
	subs, err := s.Store.ListPushSubscriptionsForDispatch(ctx, userIDs, keyID)
	if err == nil && s.calls.Add(1) == 1 {
		s.hook(ctx)
	}
	return subs, err
}

func TestPushDispatch_Condition6_WithdrawnAuthorityGovernsEveryAttempt(t *testing.T) {
	const (
		author    = int64(1)
		withdrawn = int64(2)
		control   = int64(3)
	)
	withdrawals := map[string]func(t *testing.T, ctx context.Context, f *pushDispatchFixture){
		"device subscription revoked": func(t *testing.T, ctx context.Context, f *pushDispatchFixture) {
			rows, err := f.push.List(ctx, withdrawn)
			if err != nil || len(rows) != 1 {
				t.Fatalf("List(%d) = %v, %v; want the one subscription", withdrawn, rows, err)
			}
			if err := f.push.Revoke(ctx, withdrawn, rows[0].ID); err != nil {
				t.Fatalf("Revoke: %v", err)
			}
		},
		"recipient blocks author": func(t *testing.T, ctx context.Context, f *pushDispatchFixture) {
			if err := NewBlockService(f.database).BlockUser(ctx, withdrawn, author); err != nil {
				t.Fatalf("BlockUser: %v", err)
			}
		},
	}
	// withdrawAfter is how many attempts the withdrawn recipient has already
	// had when the withdrawal lands: 0 is still queued, pushMaxAttempts-1 is
	// the last retry boundary. Each case's fetch count must equal it exactly.
	for name, withdraw := range withdrawals {
		for withdrawAfter := range pushMaxAttempts {
			t.Run(fmt.Sprintf("%s/after %d attempts", name, withdrawAfter), func(t *testing.T) {
				f := newPushDispatchFixture(t)
				seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
				for _, uid := range []int64{author, withdrawn, control} {
					seedUserRole(t, f.database, uid, 4)
				}
				const withdrawnURL = "https://push.example.net/withdrawn"
				const controlURL = "https://push.example.net/control"
				f.subscribe(t, withdrawn, withdrawnURL)
				f.subscribe(t, control, controlURL)

				fetch := newRecordingPushFetcher()
				var withdrawnCalls atomic.Int32
				fetch.onFetch(withdrawnURL, func(ctx context.Context) (*safefetch.Response, error) {
					n := int(withdrawnCalls.Add(1))
					if n > withdrawAfter {
						t.Errorf("attempt %d reached the endpoint after authority was withdrawn following attempt %d", n, withdrawAfter)
						return &safefetch.Response{StatusCode: 201}, nil
					}
					if n == withdrawAfter {
						withdraw(t, ctx, f)
					}
					return &safefetch.Response{StatusCode: 503}, nil
				})
				// The control needs the whole retry budget, so it is still
				// pending across every boundary the withdrawal can land on.
				fetch.sequence(controlURL,
					pushFetchResult{status: 503},
					pushFetchResult{status: 503},
					pushFetchResult{status: 201},
				)

				st := &afterAudienceListingStore{Store: f.database, hook: func(ctx context.Context) {
					if withdrawAfter == 0 {
						withdraw(t, ctx, f)
					}
				}}
				dispatcher := NewPushDispatcher(st, f.perms, f.push, nil, fetch)
				dispatcher.sleep = noSleep

				msgSvc := NewMessageService(f.database, f.perms, nil)
				msgSvc.RunBackgroundInlineForTest()
				msgSvc.SetPushNotifier(dispatcher)
				if _, err := msgSvc.SendMessage(context.Background(), SendMessageParams{
					UserID: author, ChannelID: 10, Username: seedUsername(author),
					Content: "@" + seedUsername(withdrawn) + " @" + seedUsername(control) + " hi",
				}); err != nil {
					t.Fatalf("SendMessage: %v", err)
				}

				if got := int(withdrawnCalls.Load()); got != withdrawAfter {
					t.Errorf("withdrawn recipient fetched %d times, want %d", got, withdrawAfter)
				}
				if got := fetch.countFor(controlURL); got != pushMaxAttempts {
					t.Errorf("control fetched %d times, want %d: one recipient's withdrawal must not cut another's retries", got, pushMaxAttempts)
				}
				d, fl, p := dispatcher.Counters()
				if d != 1 || fl != 0 || p != 0 {
					t.Errorf("counters = %d/%d/%d, want 1/0/0: the control delivered, and a refusal is not a delivery outcome", d, fl, p)
				}
			})
		}
	}
}
