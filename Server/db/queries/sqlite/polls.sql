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

-- name: GetPollForVote :one
-- A poll joined to its message, read inside the vote or end transaction. ended
-- is 1 when the poll was ended or its expiry has passed by the database clock.
SELECT p.allow_multiselect, p.version, p.ended_at, m.channel_id, m.user_id AS author_id, m.deleted,
       CAST(p.ended_at IS NOT NULL OR p.expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AS INTEGER) AS ended
FROM polls p JOIN messages m ON m.id = p.message_id
WHERE p.message_id = ?;

-- name: ListPollAnswerIDs :many
SELECT answer_id FROM poll_answers WHERE message_id = ? ORDER BY answer_id;

-- name: ListPollUserAnswerIDs :many
SELECT answer_id FROM poll_votes WHERE message_id = ? AND user_id = ? ORDER BY answer_id;

-- name: DeletePollUserVotes :exec
DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?;

-- name: InsertPollVote :exec
INSERT INTO poll_votes (message_id, answer_id, user_id) VALUES (?, ?, ?);

-- name: BumpPollVersionIfOpen :one
-- The conditional write of a vote: it moves the version only while the poll is
-- open by the database clock, so a vote can never land after the end or the
-- expiry. No row means the poll closed first.
UPDATE polls SET version = version + 1
WHERE message_id = ? AND ended_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
RETURNING version;

-- name: EndPollIfOpen :one
-- The conditional write of an end, by button or by timer. No row means the poll
-- was already ended (or does not exist).
UPDATE polls SET ended_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), version = version + 1
WHERE message_id = ? AND ended_at IS NULL
RETURNING version, ended_at;

-- name: NextPollExpiry :one
-- The soonest expiry among polls not yet ended, served by the partial index.
SELECT expires_at FROM polls WHERE ended_at IS NULL ORDER BY expires_at;

-- name: ListDuePolls :many
-- Polls to end: not yet ended and expired at or before now, oldest first.
SELECT p.message_id, m.channel_id, m.user_id AS author_id, m.deleted
FROM polls p JOIN messages m ON m.id = p.message_id
WHERE p.ended_at IS NULL AND p.expires_at <= sqlc.arg(now)
ORDER BY p.expires_at, p.message_id
LIMIT sqlc.arg(max_rows);
