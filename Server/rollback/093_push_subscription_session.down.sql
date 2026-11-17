-- Rollback of 093. Subscriptions lose their session: they no longer end with
-- the session that made them and keep the staleness-sweep lifetime, which is
-- how a pre-093 server treats every row. The index goes first, since SQLite
-- refuses to drop a column an index names.
DROP INDEX IF EXISTS idx_push_subscriptions_session;
ALTER TABLE push_subscriptions DROP COLUMN session_id;
DELETE FROM schema_versions WHERE version = '093_push_subscription_session.sql';
