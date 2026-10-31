-- A per-member upload limit the Storage page sets. NULL is the default and
-- means the member follows upload.user_quota_mb. 0 means no limit for this
-- member. Any other value is the limit in MB and replaces the server-wide one.
-- The row is created on demand when an admin sets a limit for a member who has
-- never uploaded, seeded from the attachments rows like EnsureUserStorage.
ALTER TABLE user_storage ADD COLUMN quota_mb INTEGER CHECK (quota_mb IS NULL OR quota_mb >= 0);
