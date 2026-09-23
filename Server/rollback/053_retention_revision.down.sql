DROP TRIGGER retention_channel_delete;
DROP TRIGGER retention_channel_update;
DROP TRIGGER retention_channel_insert;
DROP TRIGGER retention_server_delete;
DROP TRIGGER retention_server_update;
DROP TRIGGER retention_server_insert;
DROP TABLE retention_revision;
DELETE FROM schema_versions WHERE version = '053_retention_revision.sql';
