-- name: InsertPoll :exec
-- The poll row of a new poll message (migration 073, WP 6.9b). expires_at is
-- computed here from the message's own timestamp plus the duration modifier
-- (for example '+24 hours'), so the two can never disagree. It is written in
-- the same transaction as the message and its receipt.
INSERT INTO polls (message_id, question, allow_multiselect, expires_at)
SELECT m.id, sqlc.arg(question), sqlc.arg(allow_multiselect),
       strftime('%Y-%m-%dT%H:%M:%SZ', m.timestamp, CAST(sqlc.arg(duration_modifier) AS TEXT))
FROM messages m WHERE m.id = sqlc.arg(message_id);

-- name: InsertPollAnswer :exec
INSERT INTO poll_answers (message_id, answer_id, text, emoji)
VALUES (?, ?, ?, ?);

-- name: GetPollMeta :one
SELECT message_id, question, allow_multiselect, expires_at, ended_at, version
FROM polls WHERE message_id = ?;

-- name: GetPollsByMessageIDs :many
-- The poll block of history rows. ended is 1 when the poll was ended or its
-- expiry has passed by the database clock, so a read is correct even before
-- anything has marked the poll ended.
SELECT message_id, question, allow_multiselect, expires_at, ended_at, version,
       CAST(ended_at IS NOT NULL OR expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AS INTEGER) AS ended
FROM polls WHERE message_id IN (sqlc.slice('ids'));

-- name: GetPollAnswersByMessageIDs :many
SELECT message_id, answer_id, text, emoji
FROM poll_answers WHERE message_id IN (sqlc.slice('ids'))
ORDER BY message_id, answer_id;

-- name: GetPollAnswerCountsByMessageIDs :many
-- Votes per answer. Answers nobody chose have no row here.
SELECT message_id, answer_id, COUNT(*) AS votes
FROM poll_votes WHERE message_id IN (sqlc.slice('ids'))
GROUP BY message_id, answer_id;

-- name: GetPollVoterCountsByMessageIDs :many
-- Distinct voters per poll, the denominator of a percentage.
SELECT message_id, COUNT(DISTINCT user_id) AS voters
FROM poll_votes WHERE message_id IN (sqlc.slice('ids'))
GROUP BY message_id;

-- name: GetPollVotesByUser :many
-- The answers one viewer chose, over a page of polls.
SELECT message_id, answer_id
FROM poll_votes WHERE user_id = sqlc.arg(user_id) AND message_id IN (sqlc.slice('ids'))
ORDER BY message_id, answer_id;
