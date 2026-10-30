package db

import (
	"context"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/dbtime"
)

// PushSubscription is one Web Push subscription as listed back to its owner,
// without p256dh or auth: the listing is a device inventory, not a credential
// dump.
type PushSubscription struct {
	ID         int64
	UserID     int64
	Endpoint   string
	DeviceName string
	CreatedAt  time.Time
	LastSeenAt time.Time
}

// UpsertPushSubscription writes a subscription for userID, or refreshes the
// existing one for the same endpoint (last_seen_at bumped, credential and
// device name replaced) instead of adding a row. keyID is the VAPID key it was
// created under.
//
// The upsert, eviction ranking and eviction delete share ONE writer
// transaction: separate statements would let a concurrent refresh revive a row
// a trim had chosen to evict, and a cancellation between upsert and trim would
// leave more than keep rows. keep is the per-user device cap
// (service.maxPushSubscriptionsPerUser); the newest keep rows by last_seen_at
// (ties by id) survive.
func (d *DB) UpsertPushSubscription(ctx context.Context, userID int64, endpoint, p256dh, auth, deviceName, keyID string, keep int) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("UpsertPushSubscription begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
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
	return id, nil
}

// idsPastKeep returns everything past the first keep entries of ids, which
// ListPushSubscriptionIDsNewestFirst orders newest first.
func idsPastKeep(ids []int64, keep int) []int64 {
	if len(ids) <= keep {
		return nil
	}
	return ids[keep:]
}

// ListPushSubscriptions lists userID's subscriptions under the running VAPID
// key (keyID). A row under a different key is hidden (the server can no longer
// sign a push for it) and removed by the sweep.
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

// DeletePushSubscription removes id, scoped to userID so a guessed id cannot
// revoke another's subscription. It reports whether a row was deleted.
func (d *DB) DeletePushSubscription(ctx context.Context, userID, id int64) (bool, error) {
	n, err := d.q.DeletePushSubscription(ctx, dbgen.DeletePushSubscriptionParams{ID: id, UserID: userID})
	if err != nil {
		return false, fmt.Errorf("DeletePushSubscription: %w", err)
	}
	return n > 0, nil
}

// SweepPushSubscriptions deletes every subscription past cutoff and, when keyID
// is non-empty, every one whose vapid_key_id no longer matches (the staleness
// and rotation sweeps in one pass). An empty keyID means no key is installed
// yet, so only the time half runs.
func (d *DB) SweepPushSubscriptions(ctx context.Context, cutoff time.Time, keyID string) (int64, error) {
	n, err := d.q.SweepPushSubscriptions(ctx, dbgen.SweepPushSubscriptionsParams{
		Cutoff: cutoff.UTC().Format(dbtime.SQLiteLayout),
		KeyID:  keyID,
	})
	if err != nil {
		return 0, fmt.Errorf("SweepPushSubscriptions: %w", err)
	}
	return n, nil
}

// CountPushSubscriptions is the total row count across users, used by tests to
// prove a disabled route writes nothing.
func (d *DB) CountPushSubscriptions(ctx context.Context) (int64, error) {
	n, err := d.q.CountPushSubscriptions(ctx)
	if err != nil {
		return 0, fmt.Errorf("CountPushSubscriptions: %w", err)
	}
	return n, nil
}

// PushSubscriptionForDispatch is one subscription row as dispatch reads it,
// with the push credential (P256dh, Auth) a listing never returns.
type PushSubscriptionForDispatch struct {
	ID       int64
	UserID   int64
	Endpoint string
	P256dh   string
	Auth     string
}

// ListPushSubscriptionsForDispatch returns every subscription of userIDs under
// the running VAPID key: the last step after the caller narrowed the audience
// (not the author, offline, permitted). Empty userIDs returns no rows without
// a query.
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

// DeletePushSubscriptionByID removes a subscription by id, unscoped by user,
// for dispatch to prune a row a push service answered 404/410 for. It reports
// whether a row was deleted.
func (d *DB) DeletePushSubscriptionByID(ctx context.Context, id int64) (bool, error) {
	n, err := d.q.DeletePushSubscriptionByID(ctx, id)
	if err != nil {
		return false, fmt.Errorf("DeletePushSubscriptionByID: %w", err)
	}
	return n > 0, nil
}
