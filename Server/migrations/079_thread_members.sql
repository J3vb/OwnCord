-- Thread follows (WP 6.9c): thread_members lists the users who follow a thread.
-- A user follows by creating the thread, by posting in it, by being directly
-- mentioned in it, or by asking to. Unfollowing deletes the row and a later
-- post follows again.
--
-- A row is never permission. Nothing that decides who may see, read or post in
-- a thread reads this table, and every read of it is joined with what the
-- parent channel lets the user see. A row for a user who lost the parent stays
-- and is ignored, so regaining access brings the follow back.
--
-- Both parents cascade: deleting a thread or a user removes the rows. The
-- trigger is the backstop for the insert paths, which already select only
-- from channels of type 'thread'.

CREATE TABLE IF NOT EXISTS thread_members (
    thread_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (thread_id, user_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_thread_members_user ON thread_members(user_id);

CREATE TRIGGER IF NOT EXISTS trg_thread_members_shape_insert
BEFORE INSERT ON thread_members
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = NEW.thread_id AND c.type = 'thread')
BEGIN
    SELECT RAISE(ABORT, 'invalid thread member: thread_id must name a thread');
END;
