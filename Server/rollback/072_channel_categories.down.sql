-- Rollback of migration 072: categories go back to free text on each channel.
-- (channels.category was never dropped, so it only needs its values refreshed.)
--
-- Cost: nothing a channel shows is lost. Each channel gets its category's
-- current name back in channels.category, so the sidebar groups look the same.
-- What is lost is the category objects themselves: their order independent of
-- the channels in them, and any category that has no channel in it (an older
-- binary has no way to show an empty category). The order comes back only as
-- far as the older binary derives it from channel positions.
UPDATE channels
SET category = (SELECT cc.name FROM channel_categories cc WHERE cc.id = channels.category_id);

DROP INDEX IF EXISTS idx_channels_category_id;

ALTER TABLE channels DROP COLUMN category_id;

DROP INDEX IF EXISTS idx_channel_categories_name;

DROP TABLE IF EXISTS channel_categories;

DELETE FROM schema_versions WHERE version = '072_channel_categories.sql';
