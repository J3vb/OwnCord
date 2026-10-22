-- Rollback of migration 074: threads go away.
--
-- Cost: every thread and every message posted in one is deleted. An older
-- binary has no thread type, and its type trigger would refuse the rows. The
-- starter messages stay in their channels.
DROP TRIGGER IF EXISTS trg_channels_thread_shape_insert;
DROP TRIGGER IF EXISTS trg_channels_thread_shape_update;

-- The deletes below do by hand what the foreign keys would cascade, because
-- the sqlite3 shell runs this file with foreign keys off. Dependents of the
-- thread messages go first, then the messages, then the channel rows' own
-- dependents, then the threads.
DELETE FROM reactions WHERE message_id IN (SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.type = 'thread');
DELETE FROM mention_receipts WHERE message_id IN (SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.type = 'thread');
DELETE FROM message_mentions WHERE message_id IN (SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.type = 'thread');
DELETE FROM message_role_mentions WHERE message_id IN (SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.type = 'thread');
DELETE FROM message_group_events WHERE message_id IN (SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.type = 'thread');
DELETE FROM message_calls WHERE message_id IN (SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.type = 'thread');
DELETE FROM message_forwards WHERE message_id IN (SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.type = 'thread');
UPDATE message_forwards SET source_message_id = NULL WHERE source_message_id IN (SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.type = 'thread');
UPDATE attachments SET message_id = NULL WHERE message_id IN (SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.type = 'thread');
DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'thread');
DELETE FROM channel_overrides WHERE channel_id IN (SELECT id FROM channels WHERE type = 'thread');
DELETE FROM channel_user_overrides WHERE channel_id IN (SELECT id FROM channels WHERE type = 'thread');
DELETE FROM channel_retention WHERE channel_id IN (SELECT id FROM channels WHERE type = 'thread');
DELETE FROM nsfw_acknowledgements WHERE channel_id IN (SELECT id FROM channels WHERE type = 'thread');
DELETE FROM read_states WHERE channel_id IN (SELECT id FROM channels WHERE type = 'thread');
DELETE FROM voice_states WHERE channel_id IN (SELECT id FROM channels WHERE type = 'thread');
DELETE FROM dm_open_state WHERE channel_id IN (SELECT id FROM channels WHERE type = 'thread');
DELETE FROM dm_participants WHERE channel_id IN (SELECT id FROM channels WHERE type = 'thread');
DELETE FROM message_requests WHERE channel_id IN (SELECT id FROM channels WHERE type = 'thread');
DELETE FROM events WHERE channel_id IN (SELECT id FROM channels WHERE type = 'thread');
DELETE FROM channels WHERE type = 'thread';

DROP TRIGGER IF EXISTS trg_channels_type_check_insert;
DROP TRIGGER IF EXISTS trg_channels_type_check_update;

CREATE TRIGGER IF NOT EXISTS trg_channels_type_check_insert
BEFORE INSERT ON channels
FOR EACH ROW
WHEN NEW.type NOT IN ('text', 'voice', 'announcement', 'dm')
BEGIN
    SELECT RAISE(ABORT, 'invalid channel type: must be text, voice, announcement, or dm');
END;

CREATE TRIGGER IF NOT EXISTS trg_channels_type_check_update
BEFORE UPDATE OF type ON channels
FOR EACH ROW
WHEN NEW.type NOT IN ('text', 'voice', 'announcement', 'dm')
BEGIN
    SELECT RAISE(ABORT, 'invalid channel type: must be text, voice, announcement, or dm');
END;

DROP INDEX IF EXISTS idx_channels_thread_open_activity;
DROP INDEX IF EXISTS idx_channels_parent;
DROP INDEX IF EXISTS idx_channels_thread_starter;

ALTER TABLE channels DROP COLUMN thread_last_activity_at;
ALTER TABLE channels DROP COLUMN thread_auto_archive_minutes;
ALTER TABLE channels DROP COLUMN thread_locked;
ALTER TABLE channels DROP COLUMN thread_archived;
ALTER TABLE channels DROP COLUMN thread_owner_id;
ALTER TABLE channels DROP COLUMN thread_starter_message_id;
ALTER TABLE channels DROP COLUMN parent_channel_id;

DELETE FROM schema_versions WHERE version = '074_threads.sql';
