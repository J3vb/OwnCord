-- Rollback of migration 071: drop the forward side rows.
--
-- Cost: forwarded messages stop being marked as forwards. Each one stays in its
-- channel as an ordinary message by the forwarder, with the snapshot text and
-- files it already holds, and can be edited again. Nothing else is lost.
DROP INDEX IF EXISTS idx_message_forwards_source;
DROP TABLE IF EXISTS message_forwards;

DELETE FROM schema_versions WHERE version = '071_message_forwards.sql';
