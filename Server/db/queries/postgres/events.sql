-- name: PersistEvent :one
INSERT INTO events (event_type, channel_id, payload)
VALUES ($1, $2, $3)
RETURNING seq;

-- name: GetEventsSince :many
SELECT seq, event_type, channel_id, payload, created_at
FROM events
WHERE seq > $1
ORDER BY seq ASC
LIMIT $2;

-- name: PruneEventsOlderThan :execrows
DELETE FROM events WHERE created_at < $1;
