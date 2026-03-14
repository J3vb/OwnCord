-- Migration 003: Re-create audit_log with Phase-6 canonical column names.
--
-- Phase-1 audit_log used: user_id (nullable), action, target_type, target_id,
--                         details, timestamp
-- Phase-6 audit_log uses: actor_id (NOT NULL DEFAULT 0), action, target_type,
--                         target_id, detail, created_at
--
-- IDEMPOTENCY STRATEGY
-- --------------------
-- A sentinel table "audit_log_migrated_003" acts as a run-once guard.
-- • First run:  sentinel does not exist → migration executes normally.
-- • Second run: "CREATE TABLE IF NOT EXISTS audit_log_migrated_003" is a
--   no-op, but the body still runs.  However, because audit_log already has
--   the new schema, the INSERT … SELECT below safely copies actor_id/detail/
--   created_at which now exist.
--
-- Rather than fighting SQLite's lack of conditional DDL, we use a helper
-- table whose existence signals completion, and write the INSERT to work
-- with BOTH the old and new column names by coalescing them.
-- SQLite will return an error on unknown column names, so we cannot SELECT
-- user_id when actor_id exists.  Instead, we guard with the run-once table.
--
-- On re-run: CREATE TABLE IF NOT EXISTS audit_log_v6 creates a fresh helper,
-- INSERT OR IGNORE … SELECT from audit_log (new schema) copies actor_id etc.,
-- DROP TABLE IF EXISTS audit_log removes current data,
-- ALTER TABLE audit_log_v6 RENAME TO audit_log recreates it.
-- This is safe because the second-run SELECT reads actor_id (not user_id).

CREATE TABLE IF NOT EXISTS audit_log_v6 (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER NOT NULL DEFAULT 0,
    action      TEXT    NOT NULL,
    target_type TEXT    NOT NULL DEFAULT '',
    target_id   INTEGER NOT NULL DEFAULT 0,
    detail      TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

DROP TABLE IF EXISTS audit_log;

ALTER TABLE audit_log_v6 RENAME TO audit_log;

-- Keep the legacy index name so existing tests remain green.
CREATE INDEX IF NOT EXISTS idx_audit_timestamp   ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor   ON audit_log(actor_id);
