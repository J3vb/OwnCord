-- Drop indexes that exactly duplicate the auto-indexes SQLite creates for
-- UNIQUE constraints. sessions.token and invites.code are both declared
-- UNIQUE in 001_initial_schema.sql, so these secondary indexes provide no
-- read benefit and cost an extra index update on every session insert and
-- invite create.
DROP INDEX IF EXISTS idx_sessions_token;
DROP INDEX IF EXISTS idx_invites_code;
