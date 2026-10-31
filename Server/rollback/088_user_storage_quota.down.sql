-- Rollback of migration 088: every per-member upload limit is forgotten.
--
-- Cost: members who had their own limit fall back to upload.user_quota_mb.
-- Upload byte counters and files are untouched.
ALTER TABLE user_storage DROP COLUMN quota_mb;

DELETE FROM schema_versions WHERE version = '088_user_storage_quota.sql';
