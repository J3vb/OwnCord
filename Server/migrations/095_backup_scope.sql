-- Migration 095: what automatic backups cover.
--
-- backup_scope is "database" (the .db copy only), "everything" (the .db copy
-- plus a full archive with uploads, key files and settings) or "unset". A
-- server with no accounts yet is new, so it starts on everything. A server
-- that already has people keeps taking database-only copies as before and
-- starts on unset, which behaves as database and asks the owner to choose.
-- The row is written once and never touched by a later run.

INSERT INTO settings (key, value)
SELECT 'backup_scope', CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'unset' ELSE 'everything' END
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'backup_scope');
