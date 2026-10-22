-- Rollback of migration 075: forums go away.
--
-- Cost: every forum, every post under it and every message in those posts is
-- deleted, along with the tags and the links between tags and posts, the polls
-- and votes on those messages, and the send receipts that name them. A reply
-- elsewhere to a deleted message loses its reply target. An older
-- binary has no forum type and its type trigger would refuse the rows. Threads
-- under text channels, and every text channel, are untouched.
--
-- Run it before 074's reversal (rollback.Order lists them newest first).
DROP TRIGGER IF EXISTS trg_thread_tags_match_update;
DROP TRIGGER IF EXISTS trg_thread_tags_match_insert;
DROP TRIGGER IF EXISTS trg_forum_tags_forum_update;
DROP TRIGGER IF EXISTS trg_forum_tags_forum_insert;
DROP TRIGGER IF EXISTS trg_messages_not_moved_to_forum;
DROP TRIGGER IF EXISTS trg_messages_not_in_forum;
DROP TRIGGER IF EXISTS trg_channels_thread_shape_insert;
DROP TRIGGER IF EXISTS trg_channels_thread_shape_update;

-- The deletes below do by hand what the foreign keys would cascade, because
-- the sqlite3 shell runs this file with foreign keys off. Dependents of the
-- post messages go first, then the messages, then the dependents of the forum
-- and post rows, then the posts and forums themselves.

DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum'))));
DELETE FROM mention_receipts WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum'))));
DELETE FROM message_mentions WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum'))));
DELETE FROM message_role_mentions WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum'))));
DELETE FROM message_group_events WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum'))));
DELETE FROM message_calls WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum'))));
DELETE FROM message_forwards WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum'))));
UPDATE message_forwards SET source_message_id = NULL WHERE source_message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum'))));
UPDATE attachments SET message_id = NULL WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum'))));
DELETE FROM poll_votes WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum'))));
DELETE FROM poll_answers WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum'))));
DELETE FROM polls WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum'))));
DELETE FROM message_delivery_receipts WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum')))) OR channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum')));
UPDATE message_requests SET first_message_id = NULL WHERE first_message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum'))));
UPDATE messages SET reply_to = NULL WHERE reply_to IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum'))));
DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum')));
DELETE FROM channel_overrides WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum')));
DELETE FROM channel_user_overrides WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum')));
DELETE FROM channel_retention WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum')));
DELETE FROM nsfw_acknowledgements WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum')));
DELETE FROM read_states WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum')));
DELETE FROM voice_states WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum')));
DELETE FROM dm_open_state WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum')));
DELETE FROM dm_participants WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum')));
DELETE FROM message_requests WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum')));
DELETE FROM events WHERE channel_id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum')));
DELETE FROM channels WHERE id IN (SELECT id FROM channels WHERE type = 'forum' OR (type = 'thread' AND parent_channel_id IN (SELECT id FROM channels WHERE type = 'forum')));

DROP INDEX IF EXISTS idx_thread_tags_tag;
DROP TABLE IF EXISTS thread_tags;
DROP INDEX IF EXISTS idx_forum_tags_name;
DROP TABLE IF EXISTS forum_tags;
DROP INDEX IF EXISTS idx_channels_thread_list_activity;

DROP TRIGGER IF EXISTS trg_channels_type_check_insert;
DROP TRIGGER IF EXISTS trg_channels_type_check_update;

CREATE TRIGGER IF NOT EXISTS trg_channels_type_check_insert
BEFORE INSERT ON channels
FOR EACH ROW
WHEN NEW.type NOT IN ('text', 'voice', 'announcement', 'dm', 'thread')
BEGIN
    SELECT RAISE(ABORT, 'invalid channel type: must be text, voice, announcement, dm, or thread');
END;

CREATE TRIGGER IF NOT EXISTS trg_channels_type_check_update
BEFORE UPDATE OF type ON channels
FOR EACH ROW
WHEN NEW.type NOT IN ('text', 'voice', 'announcement', 'dm', 'thread')
BEGIN
    SELECT RAISE(ABORT, 'invalid channel type: must be text, voice, announcement, dm, or thread');
END;

-- 074's shape triggers, verbatim.
CREATE TRIGGER IF NOT EXISTS trg_channels_thread_shape_insert
BEFORE INSERT ON channels
FOR EACH ROW
WHEN (NEW.type = 'thread') <> (NEW.parent_channel_id IS NOT NULL)
  OR (NEW.type <> 'thread' AND (NEW.thread_starter_message_id IS NOT NULL OR NEW.thread_owner_id IS NOT NULL
      OR NEW.thread_archived <> 0 OR NEW.thread_locked <> 0 OR NEW.thread_last_activity_at IS NOT NULL))
  OR (NEW.type = 'thread' AND (NEW.archived <> 0 OR NEW.nsfw <> 0 OR NEW.category_id IS NOT NULL
      OR NEW.afk <> 0 OR NEW.slow_mode <> 0
      OR NOT EXISTS (SELECT 1 FROM channels p WHERE p.id = NEW.parent_channel_id AND p.type = 'text')))
BEGIN
    SELECT RAISE(ABORT, 'invalid thread row: a thread needs a text parent and takes nsfw, archive, category, afk and slow mode from it');
END;

CREATE TRIGGER IF NOT EXISTS trg_channels_thread_shape_update
BEFORE UPDATE ON channels
FOR EACH ROW
WHEN (NEW.type <> OLD.type AND (NEW.type = 'thread' OR OLD.type = 'thread'
      OR EXISTS (SELECT 1 FROM channels t WHERE t.parent_channel_id = OLD.id)))
  OR NEW.parent_channel_id IS NOT OLD.parent_channel_id
  OR (NEW.type = 'thread' AND (NEW.archived <> 0 OR NEW.nsfw <> 0 OR NEW.category_id IS NOT NULL
      OR NEW.afk <> 0 OR NEW.slow_mode <> 0
      OR (NEW.thread_starter_message_id IS NOT OLD.thread_starter_message_id AND NEW.thread_starter_message_id IS NOT NULL)))
  OR (NEW.type <> 'thread' AND (NEW.thread_starter_message_id IS NOT NULL OR NEW.thread_owner_id IS NOT NULL
      OR NEW.thread_archived <> 0 OR NEW.thread_locked <> 0 OR NEW.thread_last_activity_at IS NOT NULL))
BEGIN
    SELECT RAISE(ABORT, 'invalid thread row: type, parent and starter are fixed, and a thread takes nsfw, archive, category, afk and slow mode from its parent');
END;

ALTER TABLE channels DROP COLUMN thread_post_message_id;
ALTER TABLE channels DROP COLUMN forum_default_auto_archive_minutes;
ALTER TABLE channels DROP COLUMN forum_require_tag;

DELETE FROM schema_versions WHERE version = '075_forums.sql';
