-- Rollback of migration 075: category permission templates are forgotten.
--
-- Cost: every category's template rows (category_overrides and
-- category_user_overrides) are dropped, and every channel forgets whether it
-- was synced to its category. Nothing a channel enforces is lost: each channel
-- keeps its own channel_overrides and channel_user_overrides rows, which are
-- what permissions are computed from, so access is exactly what it was. What
-- is lost is the link: after a re-apply no channel is synced, and a category's
-- template has to be written again.
ALTER TABLE channels DROP COLUMN permissions_synced;

DROP INDEX IF EXISTS idx_category_user_overrides_user;

DROP TABLE IF EXISTS category_user_overrides;

DROP TABLE IF EXISTS category_overrides;

DELETE FROM schema_versions WHERE version = '075_category_permissions.sql';
