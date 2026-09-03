-- Erasure jobs (migration 037, B4-9): the durable file half of an account
-- erasure. The row is written inside the erasure transaction with the
-- stored_as names of every file the subject owned; the runner removes them
-- after commit and marks the job done, retrying from startup and the
-- maintenance tick until it is.

-- name: InsertErasureJob :one
INSERT INTO erasure_jobs (user_id, state, files)
VALUES (?, 'db_done', ?)
RETURNING id;

-- name: ListUnfinishedErasureJobs :many
SELECT id, user_id, state, files, files_removed, attempts, last_error
FROM erasure_jobs
WHERE state <> 'done'
ORDER BY id ASC;

-- name: GetErasureJob :one
SELECT id, user_id, state, files, files_removed, attempts, last_error, finished_at
FROM erasure_jobs
WHERE id = ?;

-- name: RecordErasureJobAttempt :exec
UPDATE erasure_jobs
SET attempts = attempts + 1,
    files_removed = ?,
    last_error = ?,
    updated_at = datetime('now')
WHERE id = ?;

-- name: CompleteErasureJob :exec
UPDATE erasure_jobs
SET state = 'done',
    files_removed = ?,
    last_error = NULL,
    attempts = attempts + 1,
    updated_at = datetime('now'),
    finished_at = datetime('now')
WHERE id = ?;

-- name: CountUnfinishedErasureJobs :one
SELECT COUNT(*) FROM erasure_jobs WHERE state <> 'done';
