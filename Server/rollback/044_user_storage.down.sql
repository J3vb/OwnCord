-- Rollback of 044. The per-user upload byte counter goes away, and the
-- attachments rows it was recounted from are untouched, so nothing is lost
-- but the cached aggregate, and re-applying 044 re-seeds it from those rows.
-- A server running with upload.user_quota_mb set will refuse every upload
-- with a database error once the table is gone -- clear that key (or restart
-- on the pre-044 build) in the same change.
DROP TABLE IF EXISTS user_storage;
DELETE FROM schema_versions WHERE version = '044_user_storage.sql';
