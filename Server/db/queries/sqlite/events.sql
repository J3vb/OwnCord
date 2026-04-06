-- name: PersistEvent :execresult
INSERT INTO events (event_type, channel_id, payload) VALUES (?, ?, ?);

-- name: GetEventsSince :many
SELECT seq, event_type, channel_id, payload, created_at
FROM events
WHERE seq > ?
ORDER BY seq ASC
LIMIT ?;

-- name: PruneEventsOlderThan :execrows
DELETE FROM events WHERE created_at < ?;
