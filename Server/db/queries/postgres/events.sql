-- name: PersistEvent :exec
-- seq is supplied by the hub so the row seq matches the wrapped-payload seq.
-- The schema's BIGSERIAL still owns the id column for inserts that omit seq,
-- but PersistEvent always supplies an explicit value.
INSERT INTO events (seq, event_type, channel_id, payload)
VALUES ($1, $2, $3, $4);

-- name: GetMaxEventSeq :one
SELECT COALESCE(MAX(seq), 0)::BIGINT FROM events;

-- name: GetEventsSince :many
SELECT seq, event_type, channel_id, payload, created_at
FROM events
WHERE seq > $1
ORDER BY seq ASC
LIMIT $2;

-- name: PruneEventsOlderThan :execrows
DELETE FROM events WHERE created_at < $1;
