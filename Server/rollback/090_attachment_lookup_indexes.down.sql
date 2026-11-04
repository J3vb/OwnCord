-- Rollback of the attachment lookup indexes (090).
--
-- The indexes are additive: dropping them only makes the stored-name lookups,
-- the orphan sweep and the newest-first upload list scan again, and no read
-- depends on them existing.
DROP INDEX IF EXISTS idx_attachments_stored_as;
DROP INDEX IF EXISTS idx_attachments_uploaded_at;
DROP INDEX IF EXISTS idx_messages_deleted;

DELETE FROM schema_versions WHERE version = '090_attachment_lookup_indexes.sql';
