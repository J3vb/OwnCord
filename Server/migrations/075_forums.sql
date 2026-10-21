-- Forums (WP 6.9d): a forum is a channel row of type 'forum' that holds no
-- messages. Its posts are threads (migration 074) whose parent is the forum,
-- each with no starter message. A post's opening message is the thread's own
-- first message, and thread_post_message_id points at it.
--
-- A forum row has no permission model of its own beyond a text channel's: its
-- overrides, NSFW flag, slow mode and archive state govern its posts through
-- the thread resolver, which keys on parent_channel_id and never on the
-- parent's type. The only place 074 hard-codes the parent type is the thread
-- shape trigger, which this migration widens from 'text' to 'text' or 'forum'.
--
-- Forum settings live on the forum row. forum_require_tag and
-- forum_default_auto_archive_minutes mean something only on a type 'forum'
-- row, and the shape triggers refuse any other value elsewhere.

ALTER TABLE channels ADD COLUMN forum_require_tag INTEGER NOT NULL DEFAULT 0
    CHECK (forum_require_tag IN (0, 1));
ALTER TABLE channels ADD COLUMN forum_default_auto_archive_minutes INTEGER NOT NULL DEFAULT 4320
    CHECK (forum_default_auto_archive_minutes IN (60, 1440, 4320, 10080));
-- A post's opening message. Set once, in the transaction that creates the post.
ALTER TABLE channels ADD COLUMN thread_post_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS forum_tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    forum_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    emoji      TEXT,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_forum_tags_name ON forum_tags(forum_id, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS thread_tags (
    thread_id INTEGER NOT NULL REFERENCES channels(id)   ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES forum_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (thread_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_thread_tags_tag ON thread_tags(tag_id, thread_id);

-- The forum list's activity order. Created order walks idx_channels_parent.
CREATE INDEX IF NOT EXISTS idx_channels_thread_list_activity
    ON channels(parent_channel_id, thread_archived, thread_last_activity_at, id)
    WHERE type = 'thread';

DROP TRIGGER IF EXISTS trg_channels_type_check_insert;
DROP TRIGGER IF EXISTS trg_channels_type_check_update;

CREATE TRIGGER IF NOT EXISTS trg_channels_type_check_insert
BEFORE INSERT ON channels
FOR EACH ROW
WHEN NEW.type NOT IN ('text', 'voice', 'announcement', 'dm', 'thread', 'forum')
BEGIN
    SELECT RAISE(ABORT, 'invalid channel type: must be text, voice, announcement, dm, thread, or forum');
END;

CREATE TRIGGER IF NOT EXISTS trg_channels_type_check_update
BEFORE UPDATE OF type ON channels
FOR EACH ROW
WHEN NEW.type NOT IN ('text', 'voice', 'announcement', 'dm', 'thread', 'forum')
BEGIN
    SELECT RAISE(ABORT, 'invalid channel type: must be text, voice, announcement, dm, thread, or forum');
END;

DROP TRIGGER IF EXISTS trg_channels_thread_shape_insert;
DROP TRIGGER IF EXISTS trg_channels_thread_shape_update;

-- Insert: 074's rules with the parent widened to a text channel or a forum.
-- A post (a thread under a forum) is born without a starter, and no row is
-- born with an opening message, because the message cannot exist before its
-- channel does. Forum settings are refused on any row that is not a forum.
CREATE TRIGGER IF NOT EXISTS trg_channels_thread_shape_insert
BEFORE INSERT ON channels
FOR EACH ROW
WHEN (NEW.type = 'thread') <> (NEW.parent_channel_id IS NOT NULL)
  OR (NEW.type <> 'thread' AND (NEW.thread_starter_message_id IS NOT NULL OR NEW.thread_owner_id IS NOT NULL
      OR NEW.thread_archived <> 0 OR NEW.thread_locked <> 0 OR NEW.thread_last_activity_at IS NOT NULL))
  OR (NEW.type = 'thread' AND (NEW.archived <> 0 OR NEW.nsfw <> 0 OR NEW.category_id IS NOT NULL
      OR NEW.afk <> 0 OR NEW.slow_mode <> 0
      OR NOT EXISTS (SELECT 1 FROM channels p WHERE p.id = NEW.parent_channel_id AND p.type IN ('text', 'forum'))
      OR (NEW.thread_starter_message_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM channels p WHERE p.id = NEW.parent_channel_id AND p.type = 'forum'))))
  OR NEW.thread_post_message_id IS NOT NULL
  OR (NEW.type <> 'forum' AND (NEW.forum_require_tag <> 0 OR NEW.forum_default_auto_archive_minutes <> 4320))
BEGIN
    SELECT RAISE(ABORT, 'invalid thread or forum row: a thread needs a text or forum parent and takes nsfw, archive, category, afk and slow mode from it, a forum post has no starter, and forum settings belong to forums');
END;

-- Update: 074's rules, plus a type change to or from 'forum' is refused, the
-- opening message pointer may go from NULL to a message in that post once (and
-- only on a post under a forum) and afterwards only to NULL, and forum
-- settings stay on forum rows.
CREATE TRIGGER IF NOT EXISTS trg_channels_thread_shape_update
BEFORE UPDATE ON channels
FOR EACH ROW
WHEN (NEW.type <> OLD.type AND (NEW.type IN ('thread', 'forum') OR OLD.type IN ('thread', 'forum')
      OR EXISTS (SELECT 1 FROM channels t WHERE t.parent_channel_id = OLD.id)))
  OR NEW.parent_channel_id IS NOT OLD.parent_channel_id
  OR (NEW.type = 'thread' AND (NEW.archived <> 0 OR NEW.nsfw <> 0 OR NEW.category_id IS NOT NULL
      OR NEW.afk <> 0 OR NEW.slow_mode <> 0
      OR (NEW.thread_starter_message_id IS NOT OLD.thread_starter_message_id AND NEW.thread_starter_message_id IS NOT NULL)))
  OR (NEW.type <> 'thread' AND (NEW.thread_starter_message_id IS NOT NULL OR NEW.thread_owner_id IS NOT NULL
      OR NEW.thread_archived <> 0 OR NEW.thread_locked <> 0 OR NEW.thread_last_activity_at IS NOT NULL))
  OR (NEW.thread_post_message_id IS NOT NULL AND NEW.thread_post_message_id IS NOT OLD.thread_post_message_id
      AND (OLD.thread_post_message_id IS NOT NULL
           OR NEW.type <> 'thread'
           OR NOT EXISTS (SELECT 1 FROM channels p WHERE p.id = NEW.parent_channel_id AND p.type = 'forum')
           OR NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = NEW.thread_post_message_id AND m.channel_id = NEW.id)))
  OR (NEW.type <> 'thread' AND NEW.thread_post_message_id IS NOT NULL)
  OR (NEW.type <> 'forum' AND (NEW.forum_require_tag <> 0 OR NEW.forum_default_auto_archive_minutes <> 4320))
BEGIN
    SELECT RAISE(ABORT, 'invalid thread or forum row: type, parent and starter are fixed, a forum post keeps one opening message, and forum settings belong to forums');
END;

-- A forum never holds a message. The service refuses a send first, and this
-- makes a missed call site fail loudly instead of creating invisible content.
CREATE TRIGGER IF NOT EXISTS trg_messages_not_in_forum
BEFORE INSERT ON messages
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM channels c WHERE c.id = NEW.channel_id AND c.type = 'forum')
BEGIN
    SELECT RAISE(ABORT, 'a forum holds no messages: post in one of its posts');
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_not_moved_to_forum
BEFORE UPDATE OF channel_id ON messages
FOR EACH ROW
WHEN NEW.channel_id IS NOT OLD.channel_id
  AND EXISTS (SELECT 1 FROM channels c WHERE c.id = NEW.channel_id AND c.type = 'forum')
BEGIN
    SELECT RAISE(ABORT, 'a forum holds no messages: post in one of its posts');
END;

-- Tag integrity. A tag belongs to a forum and never moves. A post carries
-- only tags of the forum it sits under. Counts and name length are service
-- rules checked inside the writer transaction.
CREATE TRIGGER IF NOT EXISTS trg_forum_tags_forum_insert
BEFORE INSERT ON forum_tags
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = NEW.forum_id AND c.type = 'forum')
BEGIN
    SELECT RAISE(ABORT, 'invalid forum tag: forum_id must name a forum');
END;

CREATE TRIGGER IF NOT EXISTS trg_forum_tags_forum_update
BEFORE UPDATE OF forum_id ON forum_tags
FOR EACH ROW
WHEN NEW.forum_id <> OLD.forum_id
BEGIN
    SELECT RAISE(ABORT, 'invalid forum tag: a tag never moves to another forum');
END;

CREATE TRIGGER IF NOT EXISTS trg_thread_tags_match_insert
BEFORE INSERT ON thread_tags
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM forum_tags t JOIN channels c ON c.id = NEW.thread_id
                 WHERE t.id = NEW.tag_id AND c.type = 'thread' AND c.parent_channel_id = t.forum_id)
BEGIN
    SELECT RAISE(ABORT, 'invalid thread tag: the tag must belong to the forum the post sits under');
END;

CREATE TRIGGER IF NOT EXISTS trg_thread_tags_match_update
BEFORE UPDATE ON thread_tags
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM forum_tags t JOIN channels c ON c.id = NEW.thread_id
                 WHERE t.id = NEW.tag_id AND c.type = 'thread' AND c.parent_channel_id = t.forum_id)
BEGIN
    SELECT RAISE(ABORT, 'invalid thread tag: the tag must belong to the forum the post sits under');
END;
