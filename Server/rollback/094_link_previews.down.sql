-- Rollback of 094. The link preview store goes: a pre-094 server fetches no
-- previews on the server side and keeps none. The trigger and the tables that
-- reference others go first. The thumbnail files under link-previews/ in the
-- data folder are not touched here and can be deleted by hand.
DROP TRIGGER IF EXISTS messages_link_previews_softdelete;
DROP TABLE IF EXISTS message_unfurls;
DROP TABLE IF EXISTS message_link_previews;
DROP TABLE IF EXISTS link_previews;
DROP TABLE IF EXISTS link_preview_images;
DELETE FROM schema_versions WHERE version = '094_link_previews.sql';
