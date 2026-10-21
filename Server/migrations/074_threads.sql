-- Threads (WP 6.9c): a thread is a channel row of type 'thread' under a text
-- channel, started from one of that channel's messages.
--
-- A thread has no permission state of its own. Who may see, read or write it
-- is answered by its parent channel (overrides, NSFW, archive), plus the
-- thread's own lock and archive flags. The shape triggers below make that a
-- schema fact: a thread row cannot carry its own nsfw, archived, category,
-- afk or slow mode, its parent is always a non-thread text channel, and the
-- parent link never changes after insert (the server caches it forever).
--
-- thread_archived is a thread's own idle state and is NOT channels.archived.
-- An idle-archived thread stays readable and a new message reopens it.
-- channels.archived on the parent hides the parent and every thread under it.

ALTER TABLE channels ADD COLUMN parent_channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE channels ADD COLUMN thread_starter_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE channels ADD COLUMN thread_owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE channels ADD COLUMN thread_archived INTEGER NOT NULL DEFAULT 0 CHECK (thread_archived IN (0, 1));
ALTER TABLE channels ADD COLUMN thread_locked INTEGER NOT NULL DEFAULT 0 CHECK (thread_locked IN (0, 1));
ALTER TABLE channels ADD COLUMN thread_auto_archive_minutes INTEGER NOT NULL DEFAULT 1440
    CHECK (thread_auto_archive_minutes IN (60, 1440, 4320, 10080));
ALTER TABLE channels ADD COLUMN thread_last_activity_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_thread_starter
    ON channels(thread_starter_message_id) WHERE thread_starter_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_channels_parent
    ON channels(parent_channel_id) WHERE parent_channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_channels_thread_open_activity
    ON channels(thread_last_activity_at) WHERE type = 'thread' AND thread_archived = 0;

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
