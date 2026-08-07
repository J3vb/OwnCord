-- Stop cascaded message deletes from stranding uploaded files on disk.
--
-- attachments.message_id was declared ON DELETE CASCADE in migrations/001, so
-- anything that removes a message row removes its attachment rows with it:
-- deleting a channel (channels -> messages -> attachments), the last member
-- leaving a group DM, and account deletion emptying a 1:1 DM all take that
-- path. Those rows are the ONLY handle DeleteOrphanedAttachments (the periodic
-- sweep in main.go) has on the stored files, so once the cascade removes them
-- the bytes stay on disk with nothing left that can ever find them again.
--
-- ON DELETE SET NULL turns the same cascade into an unlink: the row survives
-- with message_id NULL and its original uploaded_at, which is exactly the
-- shape the existing orphan sweep already reclaims on its next tick. Avatars
-- stay protected by that sweep's NOT EXISTS users.avatar clause, so they are
-- unaffected. One schema change covers every delete path, including
-- AdminDeleteChannel, with no caller edits.
--
-- SQLite cannot ALTER a foreign-key action, so this is the standard
-- rebuild-and-rename. attachments is a leaf table (nothing references it), so
-- neither the DROP nor the RENAME can invalidate another table's references,
-- and the copy satisfies foreign_keys=ON because every surviving message_id
-- still points at a live message row.
CREATE TABLE IF NOT EXISTS attachments_v030 (
    id          TEXT    PRIMARY KEY,
    message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    filename    TEXT    NOT NULL,
    stored_as   TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_at TEXT    NOT NULL DEFAULT (datetime('now')),
    width       INTEGER,
    height      INTEGER,
    uploader_id INTEGER REFERENCES users(id)
);

INSERT INTO attachments_v030 (id, message_id, filename, stored_as, mime_type,
                              size, uploaded_at, width, height, uploader_id)
SELECT id, message_id, filename, stored_as, mime_type,
       size, uploaded_at, width, height, uploader_id
FROM attachments;

DROP TABLE attachments;

ALTER TABLE attachments_v030 RENAME TO attachments;

-- Recreate the indexes the rebuild dropped with the old table. These mirror
-- migrations/010 and migrations/019 exactly.
CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploader_id);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
