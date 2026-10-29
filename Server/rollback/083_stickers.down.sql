-- Rollback of migration 083: drop the sticker set and the sticker side rows.
--
-- Cost: every sticker is lost, and the stored image files are left on disk
-- until the orphan sweep or an operator removes them. Each sticker message
-- stays in its channel as an ordinary message by its author showing the text
-- "[Sticker: name]", and can be edited again. Nothing else is lost.
DROP INDEX IF EXISTS idx_message_stickers_sticker;
DROP TABLE IF EXISTS message_stickers;
DROP TABLE IF EXISTS stickers;

DELETE FROM schema_versions WHERE version = '083_stickers.sql';
