package db

import (
	"context"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// PushSubscription is one Web Push subscription (migration 045, B5-4), as
// listed back to its owner: no p256dh or auth, because those are the push
// credential and the listing is a device inventory, not a credential dump.
type PushSubscription struct {
	ID         int64
	UserID     int64
	Endpoint   string
	DeviceName string
	CreatedAt  time.Time
	LastSeenAt time.Time
}

// UpsertPushSubscription writes a subscription for userID, or refreshes an
// existing one for the same endpoint (last_seen_at bumped, credential and
// device name replaced) rather than creating a second row — this is how a
// client keeps a subscription alive with no dispatch failure to prompt it
// (there is none yet; dispatch is B5-11). keyID is the VAPID key it was
// created under (service.PushService.PublicKey's key_id).
//
// The upsert, the eviction ranking and the eviction delete run inside ONE
// writer transaction: three separate statements would let a concurrent
// refresh revive a row an interleaved trim had already chosen to evict, and
// a cancellation after the upsert but before the trim would leave more than
// keep rows in place. keep is the per-user device cap
// (service.maxPushSubscriptionsPerUser); the newest keep rows by
// last_seen_at (ties broken by id) survive.
func (d *DB) UpsertPushSubscription(ctx context.Context, userID int64, endpoint, p256dh, auth, deviceName, keyID string, keep int) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("UpsertPushSubscription begin: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	q := d.q.WithTx(tx)

	id, err := q.UpsertPushSubscription(ctx, dbgen.UpsertPushSubscriptionParams{
		UserID:     userID,
		Endpoint:   endpoint,
		P256dh:     p256dh,
		Auth:       auth,
		DeviceName: deviceName,
		VapidKeyID: keyID,
	})
	if err != nil {
		return 0, fmt.Errorf("UpsertPushSubscription: %w", err)
	}

	if keep < 0 {
		keep = 0
	}
	ids, err := q.ListPushSubscriptionIDsNewestFirst(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("UpsertPushSubscription trim list: %w", err)
	}
	for _, evictID := range idsPastKeep(ids, keep) {
		if _, err := q.DeletePushSubscription(ctx, dbgen.DeletePushSubscriptionParams{ID: evictID, UserID: userID}); err != nil {
			return 0, fmt.Errorf("UpsertPushSubscription trim delete %d: %w", evictID, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("UpsertPushSubscription commit: %w", err)
	}
	committed = true
	return id, nil
}

// idsPastKeep returns the ids to evict: everything past the first keep
// entries of ids, which ListPushSubscriptionIDsNewestFirst already orders
// newest first.
func idsPastKeep(ids []int64, keep int) []int64 {
	if len(ids) <= keep {
		return nil
	}
	return ids[keep:]
}

// ListPushSubscriptions lists userID's subscriptions under the currently
// running VAPID key (keyID). A row under a different key is invisible here
// (the server can no longer sign a push for it) and is removed by the sweep,
// not listed as if it still worked.
func (d *DB) ListPushSubscriptions(ctx context.Context, userID int64, keyID string) ([]PushSubscription, error) {
	rows, err := d.q.ListPushSubscriptions(ctx, dbgen.ListPushSubscriptionsParams{
		UserID:     userID,
		VapidKeyID: keyID,
	})
	if err != nil {
		return nil, fmt.Errorf("ListPushSubscriptions: %w", err)
	}
	out := make([]PushSubscription, 0, len(rows))
	for _, r := range rows {
		out = append(out, PushSubscription{
			ID:         r.ID,
			UserID:     userID,
			Endpoint:   r.Endpoint,
			DeviceName: r.DeviceName,
			CreatedAt:  parseSQLiteTime(r.CreatedAt),
			LastSeenAt: parseSQLiteTime(r.LastSeenAt),
		})
	}
	return out, nil
}

// DeletePushSubscription removes id, scoped to userID so one user can never
// revoke another's subscription by guessing an id. Reports whether a row was
// deleted.
func (d *DB) DeletePushSubscription(ctx context.Context, userID, id int64) (bool, error) {
	n, err := d.q.DeletePushSubscription(ctx, dbgen.DeletePushSubscriptionParams{ID: id, UserID: userID})
	if err != nil {
		return false, fmt.Errorf("DeletePushSubscription: %w", err)
	}
	return n > 0, nil
}

// SweepPushSubscriptions deletes every subscription past cutoff and, when
// keyID is non-empty, every subscription whose vapid_key_id no longer
// matches the running key — the staleness sweep and the rotation sweep in
// one pass (decisions 2 and 5). An empty keyID means no key is installed
// yet, so the rotation half is skipped (time-only).
func (d *DB) SweepPushSubscriptions(ctx context.Context, cutoff time.Time, keyID string) (int64, error) {
	n, err := d.q.SweepPushSubscriptions(ctx, dbgen.SweepPushSubscriptionsParams{
		Cutoff: cutoff.UTC().Format("2006-01-02 15:04:05"),
		KeyID:  keyID,
	})
	if err != nil {
		return 0, fmt.Errorf("SweepPushSubscriptions: %w", err)
	}
	return n, nil
}

// CountPushSubscriptions is the total row count across every user — used by
// tests to prove a disabled route writes nothing.
func (d *DB) CountPushSubscriptions(ctx context.Context) (int64, error) {
	n, err := d.q.CountPushSubscriptions(ctx)
	if err != nil {
		return 0, fmt.Errorf("CountPushSubscriptions: %w", err)
	}
	return n, nil
}

// PushSubscriptionForDispatch is one subscription row as dispatch (B5-11)
// reads it: with the push credential (P256dh, Auth) a listing endpoint never
// returns.
type PushSubscriptionForDispatch struct {
	ID       int64
	UserID   int64
	Endpoint string
	P256dh   string
	Auth     string
}

// ListPushSubscriptionsForDispatch returns every subscription belonging to
// one of userIDs, scoped to the running VAPID key — the audience dispatch
// already narrowed down (not the author, offline, permitted) is the caller's
// to compute; this is the last step, fetching what to push to. An empty
// userIDs returns no rows without a query round-trip.
func (d *DB) ListPushSubscriptionsForDispatch(ctx context.Context, userIDs []int64, keyID string) ([]PushSubscriptionForDispatch, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	rows, err := d.q.ListPushSubscriptionsForDispatch(ctx, dbgen.ListPushSubscriptionsForDispatchParams{
		UserIds:    userIDs,
		VapidKeyID: keyID,
	})
	if err != nil {
		return nil, fmt.Errorf("ListPushSubscriptionsForDispatch: %w", err)
	}
	out := make([]PushSubscriptionForDispatch, 0, len(rows))
	for _, r := range rows {
		out = append(out, PushSubscriptionForDispatch{
			ID:       r.ID,
			UserID:   r.UserID,
			Endpoint: r.Endpoint,
			P256dh:   r.P256dh,
			Auth:     r.Auth,
		})
	}
	return out, nil
}

// DeletePushSubscriptionByID removes a subscription by id, unscoped by user
// — dispatch (B5-11) uses this to prune a row a push service answered
// 404/410 for; it already read the id from a row it was allowed to read, and
// nothing else calls it. Reports whether a row was deleted.
func (d *DB) DeletePushSubscriptionByID(ctx context.Context, id int64) (bool, error) {
	n, err := d.q.DeletePushSubscriptionByID(ctx, id)
	if err != nil {
		return false, fmt.Errorf("DeletePushSubscriptionByID: %w", err)
	}
	return n > 0, nil
}
