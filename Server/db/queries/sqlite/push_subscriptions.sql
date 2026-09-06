-- push_subscriptions is the Web Push subscription store (migration 045,
-- B5-4). Keep this file ASCII-only: sqlc v1.30 truncates the next query by
-- the byte/rune difference of any multi-byte character.

-- name: UpsertPushSubscription :one
-- One row per (user, endpoint): re-subscribing the same endpoint refreshes
-- its credential and its last_seen_at rather than creating a second row,
-- which is how a client keeps a subscription alive without a dispatch
-- failure to prompt it (there is none yet -- B5-11).
INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_name, vapid_key_id)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(user_id, endpoint) DO UPDATE SET
    p256dh       = excluded.p256dh,
    auth         = excluded.auth,
    device_name  = excluded.device_name,
    vapid_key_id = excluded.vapid_key_id,
    last_seen_at = datetime('now')
RETURNING id;

-- name: ListPushSubscriptions :many
-- Scoped to the running VAPID key: a row whose key id does not match is a
-- subscription the server can no longer sign for, so it is invisible here
-- (and removed by the sweep) rather than listed as if it still worked.
-- p256dh and auth are never selected -- they are a push credential, not
-- something the owning user's own listing needs back.
SELECT id, endpoint, device_name, created_at, last_seen_at
  FROM push_subscriptions
 WHERE user_id = ? AND vapid_key_id = ?
 ORDER BY last_seen_at DESC, id DESC;

-- name: DeletePushSubscription :execrows
DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?;

-- name: ListPushSubscriptionIDsNewestFirst :many
-- Backs the per-user device cap (service.maxPushSubscriptionsPerUser),
-- inside DB.UpsertPushSubscription's transaction: the caller keeps the
-- first `keep` ids and deletes the rest. A self-referencing DELETE...WHERE
-- id NOT IN (SELECT ... FROM the same table) reads as an ambiguous column
-- reference to sqlc's analyzer, so the ranking and the delete are two
-- statements rather than one.
SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY last_seen_at DESC, id DESC;

-- name: SweepPushSubscriptions :execrows
-- The staleness sweep (decision 5) and the rotation sweep (decision 2) in
-- one statement: a row older than cutoff goes, and so does a row whose key
-- id no longer matches the running key. key_id = '' means "no key installed
-- yet" -- time-only, since there is nothing to compare against.
DELETE FROM push_subscriptions
 WHERE last_seen_at < sqlc.arg(cutoff)
    OR (CAST(sqlc.arg(key_id) AS TEXT) <> '' AND vapid_key_id <> CAST(sqlc.arg(key_id) AS TEXT));

-- name: CountPushSubscriptions :one
SELECT COUNT(*) FROM push_subscriptions;

-- name: ListPushSubscriptionsForDispatch :many
-- Dispatch-only (B5-11): unlike ListPushSubscriptions this returns the push
-- credential (p256dh, auth) for a caller-chosen set of candidate users --
-- never exposed to a listing endpoint. Scoped to the running VAPID key for
-- the same reason ListPushSubscriptions is: a row under a different key is
-- one the server can no longer sign for.
SELECT user_id, id, endpoint, p256dh, auth
  FROM push_subscriptions
 WHERE user_id IN (sqlc.slice('user_ids')) AND vapid_key_id = ?;

-- name: DeletePushSubscriptionByID :execrows
-- Dispatch-only (B5-11), unscoped by user_id on purpose: a push service's
-- 404/410 names a subscription by id, not by the user who owns it, and
-- dispatch already resolved the id from a row it is allowed to read. Do not
-- widen the user-scoped DeletePushSubscription to double as this.
DELETE FROM push_subscriptions WHERE id = ?;
