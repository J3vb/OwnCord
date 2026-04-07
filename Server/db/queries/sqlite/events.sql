-- name: PersistEvent :exec
-- seq is supplied by the hub so the row seq matches the wrapped-payload seq.
INSERT INTO events (seq, event_type, channel_id, payload) VALUES (?, ?, ?, ?);

-- name: GetMaxEventSeq :one
SELECT CAST(COALESCE(MAX(seq), 0) AS INTEGER) AS max_seq FROM events;

-- name: GetEventsSince :many
SELECT seq, event_type, channel_id, payload, created_at
FROM events
WHERE seq > ?
ORDER BY seq ASC
LIMIT ?;

-- name: PruneEventsOlderThan :execrows
DELETE FROM events WHERE created_at < ?;
