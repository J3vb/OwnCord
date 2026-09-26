-- B5-2 (plan decision 11, SEC-04): a durable per-user byte counter for
-- upload storage. It is charged BEFORE every FileStore write of an
-- attachment or avatar, counted where the bytes are written, and
-- recounted from the rows on every maintenance tick, so erasure, retention
-- and the orphan sweep return bytes. The counter is a cached aggregate of
-- the attachments rows that are the truth (avatars are attachments), and the
-- sweep repairs it in either direction: a crash between the charge and the
-- write leaves it HIGH until the next tick, never low. ON DELETE CASCADE
-- takes the row with the account (erasureStatements deletes it explicitly
-- first, and db.SubjectInventory counts it, class 12a). Emoji are NOT
-- counted here: they are server-wide assets that change owner on erasure
-- (db/erasure.go erasureReassignAssets), gated on MANAGE_SERVER and bounded
-- to MaxEmojiCount files of maxEmojiFileBytes each, and they still go through
-- the headroom floor (service.UploadService.Reserve with no quota charge).
CREATE TABLE IF NOT EXISTS user_storage (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bytes_used INTEGER NOT NULL DEFAULT 0 CHECK (bytes_used >= 0)
);

-- Seed every existing uploader's counter from the attachments rows, so an
-- operator who sets a quota after upgrading starts from the truth rather
-- than from zero. The JOIN matters: a legacy uploader_id with no users row
-- (attachments.uploader_id is nullable and predates its foreign key) would
-- otherwise violate the counter's foreign key and fail the migration.
INSERT INTO user_storage (user_id, bytes_used)
SELECT a.uploader_id, SUM(a.size)
  FROM attachments a
  JOIN users u ON u.id = a.uploader_id
 GROUP BY a.uploader_id;
