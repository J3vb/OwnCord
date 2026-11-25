-- Rollback of 095. data-only: no schema.
--
-- The migration only added the backup_scope settings row, so there is no
-- schema to undo. A pre-095 server takes database copies only and ignores
-- backup_scope and backup_disk_ack (the second comes only from the panel), so
-- both are removed to leave the settings as that server wrote them.
DELETE FROM settings WHERE key IN ('backup_scope', 'backup_disk_ack');
DELETE FROM schema_versions WHERE version = '095_backup_scope.sql';
