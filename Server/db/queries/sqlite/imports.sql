-- Discord channel import (migration 087). The importer builds a channel with
-- import_pending = 1, fills it chunk by chunk, then publishes it in one
-- transaction. See db/discord_import.go.

-- name: GetImportAccountID :one
-- The hidden import account is the one users row whose registration_status is
-- 'system'. The partial unique index on that value keeps it to one row.
SELECT id FROM users WHERE registration_status = 'system';

-- name: CreateImportAccount :execresult
-- The password '!' is not a bcrypt hash, so no password check can ever match it.
-- It takes the default role only to satisfy the column, and the caller drops its
-- user_roles row so no role count, role mention or @everyone ever reaches it.
INSERT INTO users (username, password, role_id, registration_status)
VALUES (?, '!', (SELECT r.id FROM roles r WHERE r.is_default = 1 ORDER BY r.id ASC), 'system');

-- name: CreateImportChannel :execresult
INSERT INTO channels (name, type, category_id, topic, position, import_pending)
VALUES (?, 'text', ?, ?, ?, 1);

-- name: InsertImportJob :execresult
INSERT INTO import_jobs (channel_id, created_by, source_name, discord_channel_id)
VALUES (?, ?, ?, ?);

-- name: GetImportJob :one
SELECT id, channel_id, created_by, source_name, discord_channel_id, status,
       total, imported, skipped, skipped_attachments, error, created_at, finished_at
FROM import_jobs WHERE id = ?;

-- name: ListRunningImportJobs :many
SELECT id, channel_id FROM import_jobs WHERE status = 'running' ORDER BY id ASC;

-- name: InsertImportMessage :one
INSERT INTO messages (channel_id, user_id, content, reply_to, edited_at, pinned, pinned_at, timestamp)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
RETURNING id;

-- name: InsertImportAuthor :exec
INSERT INTO message_import_authors (message_id, discord_user_id, name, color)
VALUES (?, ?, ?, ?);

-- name: LinkImportAttachment :execrows
UPDATE attachments SET message_id = ?
WHERE id = ? AND uploader_id = ? AND message_id IS NULL;

-- name: UpdateImportJobProgress :execrows
UPDATE import_jobs
SET total = ?, imported = ?, skipped = ?, skipped_attachments = ?
WHERE id = ? AND status = 'running';

-- name: PublishImportChannel :execrows
UPDATE channels SET import_pending = 0 WHERE id = ? AND import_pending = 1;

-- name: MarkImportChannelRead :exec
-- Every active account's read pointer, and every pending applicant's, goes past
-- the last imported message, so an import raises no unread badge. The hidden import account has no read states.
INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count)
SELECT u.id, sqlc.arg(channel_id), sqlc.arg(last_message_id), 0
FROM users u WHERE u.registration_status IN ('active', 'pending')
ON CONFLICT(user_id, channel_id) DO UPDATE SET
    last_message_id = excluded.last_message_id,
    mention_count = 0;

-- name: FinishImportJob :execrows
UPDATE import_jobs
SET status = ?, error = ?, total = ?, imported = ?, skipped = ?, skipped_attachments = ?,
    finished_at = datetime('now')
WHERE id = ? AND status = 'running';

-- name: ListPendingImportChannelIDs :many
SELECT id FROM channels WHERE import_pending = 1 ORDER BY id ASC;

-- name: DeletePendingImportChannel :exec
-- Only while still pending, so a published channel is never removed by a late
-- cleanup. Messages, author rows, read states and overrides go with it, and
-- attachment rows lose their message link for the orphan sweep.
DELETE FROM channels WHERE id = ? AND import_pending = 1;

-- name: GetImportChannelPlacement :one
SELECT name, category_id FROM channels WHERE id = ?;

-- name: ListVisibleChannelNamesInCategory :many
-- Names of the visible text channels in one category (0 = none), other than the
-- channel itself. The caller compares them with the same case folding the admin
-- routes use.
SELECT name FROM channels
WHERE id <> sqlc.arg(self_id) AND import_pending = 0 AND type = 'text'
  AND parent_channel_id IS NULL
  AND COALESCE(category_id, 0) = sqlc.arg(category_id);

-- name: RenameImportChannel :exec
UPDATE channels SET name = ? WHERE id = ?;
