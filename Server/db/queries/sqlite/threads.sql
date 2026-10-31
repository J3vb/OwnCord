-- Threads (WP 6.9c): a thread is a channels row of type 'thread' under a text
-- channel (migration 074). The shape triggers keep nsfw, archive, category,
-- afk and slow mode at their defaults on a thread row, so none of them is
-- written here. thread_last_activity_at is TEXT in '%Y-%m-%dT%H:%M:%SZ'.

-- name: InsertThread :execresult
INSERT INTO channels (name, type, parent_channel_id, thread_starter_message_id, thread_owner_id,
                      thread_auto_archive_minutes, thread_last_activity_at)
VALUES (sqlc.arg(name), 'thread', sqlc.arg(parent_id), sqlc.arg(starter_message_id), sqlc.arg(owner_id),
        sqlc.arg(auto_archive_minutes), sqlc.arg(last_activity_at));

-- name: GetThreadInfo :one
SELECT c.id, COALESCE(c.parent_channel_id, 0) AS parent_id, c.name, c.thread_owner_id,
       c.thread_starter_message_id, c.thread_archived, c.thread_locked,
       c.thread_auto_archive_minutes,
       (SELECT COUNT(*) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0 AND m.kind = 0) AS message_count,
       (SELECT MAX(m.timestamp) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0) AS last_message_at,
       c.created_at
FROM channels c
WHERE c.id = sqlc.arg(id) AND c.type = 'thread';

-- name: GetThreadInfoByStarter :one
SELECT c.id, COALESCE(c.parent_channel_id, 0) AS parent_id, c.name, c.thread_owner_id,
       c.thread_starter_message_id, c.thread_archived, c.thread_locked,
       c.thread_auto_archive_minutes,
       (SELECT COUNT(*) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0 AND m.kind = 0) AS message_count,
       (SELECT MAX(m.timestamp) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0) AS last_message_at,
       c.created_at
FROM channels c
WHERE c.thread_starter_message_id = sqlc.arg(starter_message_id) AND c.type = 'thread';

-- name: ListThreadInfosByStarters :many
SELECT c.id, COALESCE(c.parent_channel_id, 0) AS parent_id, c.name, c.thread_owner_id,
       c.thread_starter_message_id, c.thread_archived, c.thread_locked,
       c.thread_auto_archive_minutes,
       (SELECT COUNT(*) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0 AND m.kind = 0) AS message_count,
       (SELECT MAX(m.timestamp) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0) AS last_message_at,
       c.created_at
FROM channels c
WHERE c.thread_starter_message_id IN (sqlc.slice('starter_ids')) AND c.type = 'thread';

-- Newest activity first, a keyset page on (thread_last_activity_at, id). The
-- cursor is the (before_activity, before_id) pair read off the previous page's
-- last row, never re-read from the table, so a post in that thread between
-- pages cannot move the page. before_id 0 is the first page. tag_ids is a
-- comma-wrapped list such as ',3,7,' matched any-of (forum posts), and
-- no_tag_filter 1 skips it. The page of ids is picked first and only those
-- rows get their message count and last message time.
-- name: ListThreadInfosByParent :many
WITH page AS (
    SELECT c.id
    FROM channels c
    WHERE c.parent_channel_id = sqlc.arg(parent_id) AND c.type = 'thread'
      AND c.thread_archived = sqlc.arg(archived)
      AND (CAST(sqlc.arg(no_tag_filter) AS INTEGER) = 1
           OR EXISTS (SELECT 1 FROM thread_tags tt
                      WHERE tt.thread_id = c.id AND instr(CAST(sqlc.arg(tag_ids) AS TEXT), ',' || tt.tag_id || ',') > 0))
      AND (CAST(sqlc.arg(before_id) AS INTEGER) = 0
           OR COALESCE(c.thread_last_activity_at, '') < CAST(sqlc.arg(before_activity) AS TEXT)
           OR (COALESCE(c.thread_last_activity_at, '') = CAST(sqlc.arg(before_activity) AS TEXT)
               AND c.id < CAST(sqlc.arg(before_id) AS INTEGER)))
    ORDER BY COALESCE(c.thread_last_activity_at, '') DESC, c.id DESC
    LIMIT sqlc.arg(row_limit)
)
SELECT c.id, COALESCE(c.parent_channel_id, 0) AS parent_id, c.name, c.thread_owner_id,
       c.thread_starter_message_id, c.thread_archived, c.thread_locked,
       c.thread_auto_archive_minutes,
       (SELECT COUNT(*) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0 AND m.kind = 0) AS message_count,
       (SELECT MAX(m.timestamp) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0) AS last_message_at,
       c.created_at,
       COALESCE(c.thread_last_activity_at, '') AS activity_at
FROM page
JOIN channels c ON c.id = page.id
ORDER BY COALESCE(c.thread_last_activity_at, '') DESC, c.id DESC;

-- The same page in creation order (sort=created): newest id first, a keyset
-- page on id alone. Ids only grow, so id order is creation order. tag_ids is
-- a comma-wrapped list such as ',3,7,' matched any-of, and
-- no_tag_filter 1 skips it. (Not sqlc.slice: its bare ? placeholders collide
-- with the reused numbered ones.) before_id 0 is the first page.
-- name: ListThreadInfosByParentCreated :many
SELECT c.id, COALESCE(c.parent_channel_id, 0) AS parent_id, c.name, c.thread_owner_id,
       c.thread_starter_message_id, c.thread_archived, c.thread_locked,
       c.thread_auto_archive_minutes,
       (SELECT COUNT(*) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0 AND m.kind = 0) AS message_count,
       (SELECT MAX(m.timestamp) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0) AS last_message_at,
       c.created_at,
       COALESCE(c.thread_last_activity_at, '') AS activity_at
FROM channels c
WHERE c.parent_channel_id = sqlc.arg(parent_id) AND c.type = 'thread'
  AND c.thread_archived = sqlc.arg(archived)
  AND (CAST(sqlc.arg(no_tag_filter) AS INTEGER) = 1
       OR EXISTS (SELECT 1 FROM thread_tags tt
                  WHERE tt.thread_id = c.id AND instr(CAST(sqlc.arg(tag_ids) AS TEXT), ',' || tt.tag_id || ',') > 0))
  AND (CAST(sqlc.arg(before_id) AS INTEGER) = 0 OR c.id < CAST(sqlc.arg(before_id) AS INTEGER))
ORDER BY c.id DESC
LIMIT sqlc.arg(row_limit);

-- name: IsThreadChannel :one
SELECT EXISTS(SELECT 1 FROM channels WHERE id = ? AND type = 'thread');

-- name: UpdateThreadRow :execrows
UPDATE channels
SET name = sqlc.arg(name), thread_archived = sqlc.arg(archived), thread_locked = sqlc.arg(locked),
    thread_auto_archive_minutes = sqlc.arg(auto_archive_minutes)
WHERE id = sqlc.arg(id) AND type = 'thread';

-- Activity is set on every committed message in the thread, and a post to an
-- archived thread reopens it, in the sender's transaction.
-- name: TouchThreadOnPost :exec
UPDATE channels
SET thread_last_activity_at = sqlc.arg(at), thread_archived = 0
WHERE id = sqlc.arg(id) AND type = 'thread';

-- name: DeleteThreadRow :execrows
DELETE FROM channels WHERE id = ? AND type = 'thread';

-- The earliest instant an open thread is due to archive, in unix seconds, or
-- NULL when none is open. Ranges over the partial index of open threads.
-- name: NextThreadArchiveDue :one
SELECT MIN(CAST(strftime('%s', thread_last_activity_at) AS INTEGER) + thread_auto_archive_minutes * 60) AS due_at
FROM channels
WHERE type = 'thread' AND thread_archived = 0 AND thread_last_activity_at IS NOT NULL;

-- name: ListThreadsDueForArchive :many
SELECT id, COALESCE(parent_channel_id, 0) AS parent_id
FROM channels
WHERE type = 'thread' AND thread_archived = 0 AND thread_last_activity_at IS NOT NULL
  AND CAST(strftime('%s', thread_last_activity_at) AS INTEGER) + thread_auto_archive_minutes * 60 <= CAST(sqlc.arg(now_unix) AS INTEGER)
ORDER BY thread_last_activity_at ASC, id ASC
LIMIT sqlc.arg(row_limit);

-- Compare-and-archive: a post that landed after the list reopened or touched
-- the thread, and the due test no longer matches.
-- name: ArchiveThreadIfDue :execrows
UPDATE channels SET thread_archived = 1
WHERE id = sqlc.arg(id) AND type = 'thread' AND thread_archived = 0 AND thread_last_activity_at IS NOT NULL
  AND CAST(strftime('%s', thread_last_activity_at) AS INTEGER) + thread_auto_archive_minutes * 60 <= CAST(sqlc.arg(now_unix) AS INTEGER);

-- Forum posts (WP 6.9d). A post is a thread under a forum with no starter;
-- InsertThread writes it with a NULL starter_message_id.

-- name: SetThreadPostMessage :execrows
UPDATE channels SET thread_post_message_id = sqlc.arg(message_id)
WHERE id = sqlc.arg(id) AND type = 'thread' AND thread_post_message_id IS NULL;

-- name: IsForumChannel :one
SELECT EXISTS(SELECT 1 FROM channels WHERE id = ? AND type = 'forum');

-- name: CountForumTagsIn :one
SELECT COUNT(*) FROM forum_tags
WHERE forum_id = sqlc.arg(forum_id) AND id IN (sqlc.slice('tag_ids'));

-- name: InsertThreadTag :exec
INSERT INTO thread_tags (thread_id, tag_id) VALUES (?, ?);

-- name: DeleteThreadTags :exec
DELETE FROM thread_tags WHERE thread_id = ?;

-- The opening message of each listed post. Only threads whose parent is a
-- forum match, so a text-channel thread never carries a post block.
-- name: ListThreadPosts :many
SELECT c.id AS thread_id, c.thread_post_message_id AS post_message_id,
       m.user_id AS author_id, COALESCE(m.content, '') AS content,
       COALESCE(m.deleted, 0) AS deleted,
       EXISTS(SELECT 1 FROM attachments a WHERE a.message_id = c.thread_post_message_id) AS has_attachments
FROM channels c
JOIN channels p ON p.id = c.parent_channel_id AND p.type = 'forum'
LEFT JOIN messages m ON m.id = c.thread_post_message_id
WHERE c.type = 'thread' AND c.id IN (sqlc.slice('thread_ids'));

-- name: ListThreadTagLinks :many
SELECT tt.thread_id, tt.tag_id
FROM thread_tags tt
JOIN forum_tags ft ON ft.id = tt.tag_id
WHERE tt.thread_id IN (sqlc.slice('thread_ids'))
ORDER BY tt.thread_id ASC, ft.position ASC, ft.id ASC;

-- Thread follows (WP 6.9c, migration 079). A row is never permission: every
-- read below is for the caller to join with the parent's visibility.

-- The insert path checks the type, so a row can only name a thread. rows
-- affected is 1 when the user was newly joined and 0 when they already were.
-- name: JoinThread :execrows
INSERT OR IGNORE INTO thread_members (thread_id, user_id)
SELECT c.id, sqlc.arg(user_id) FROM channels c
WHERE c.id = sqlc.arg(thread_id) AND c.type = 'thread';

-- name: LeaveThread :execrows
DELETE FROM thread_members WHERE thread_id = ? AND user_id = ?;

-- name: IsThreadFollower :one
SELECT EXISTS(SELECT 1 FROM thread_members WHERE thread_id = ? AND user_id = ?);

-- name: ListThreadFollowerIDs :many
SELECT user_id FROM thread_members WHERE thread_id = ? ORDER BY user_id ASC;

-- The user's followed open threads with their read position, newest activity
-- first. Unread counts stop at 100, as a channel's do.
-- name: ListFollowedThreadStates :many
SELECT c.id, COALESCE(c.parent_channel_id, 0) AS parent_id, c.name, c.thread_owner_id,
       c.thread_starter_message_id, c.thread_archived, c.thread_locked,
       c.thread_auto_archive_minutes,
       (SELECT COUNT(*) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0 AND m.kind = 0) AS message_count,
       (SELECT MAX(m.timestamp) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0) AS last_message_at,
       c.created_at,
       (SELECT COALESCE(MAX(m.id), 0) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0) AS last_message_id,
       COALESCE((SELECT rs.last_message_id FROM read_states rs
                  WHERE rs.channel_id = c.id AND rs.user_id = tm.user_id), 0) AS last_read_message_id,
       (SELECT COUNT(*) FROM (SELECT 1 FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0
           AND m.id > COALESCE((SELECT rs.last_message_id FROM read_states rs
                                 WHERE rs.channel_id = c.id AND rs.user_id = tm.user_id), 0)
         LIMIT 100)) AS unread_count,
       COALESCE((SELECT rs.mention_count FROM read_states rs
                  WHERE rs.channel_id = c.id AND rs.user_id = tm.user_id), 0) AS mention_count
FROM thread_members tm
JOIN channels c ON c.id = tm.thread_id AND c.type = 'thread'
WHERE tm.user_id = sqlc.arg(user_id) AND c.thread_archived = 0
ORDER BY COALESCE(c.thread_last_activity_at, '') DESC, c.id DESC
LIMIT sqlc.arg(row_limit);
