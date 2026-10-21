-- Rollback of migration 073: threads go away.
--
-- Cost: every thread and every message posted in one is deleted. An older
-- binary has no thread type, and its type trigger would refuse the rows. The
-- starter messages stay in their channels.
DROP TRIGGER IF EXISTS trg_channels_thread_shape_insert;
DROP TRIGGER IF EXISTS trg_channels_thread_shape_update;

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

DELETE FROM schema_versions WHERE version = '073_threads.sql';
