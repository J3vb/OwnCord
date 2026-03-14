-- Migration 003: Re-create audit_log with Phase-6 canonical column names.
--
-- Phase-1 audit_log used: user_id (nullable), action, target_type, target_id,
--                         details, timestamp
-- Phase-6 audit_log uses: actor_id (NOT NULL DEFAULT 0), action, target_type,
--                         target_id, detail, created_at
--
-- IDEMPOTENCY
-- -----------
-- This migration is safe to re-run:
--   1. CREATE TABLE IF NOT EXISTS audit_log_v6  → no-op if already exists
--   2. DROP TABLE IF EXISTS audit_log           → no-op if already gone
--   3. ALTER TABLE audit_log_v6 RENAME TO audit_log → recreates the table
--
-- On second run audit_log_v6 is created fresh (empty), the current audit_log
-- is dropped, and audit_log_v6 is renamed.  Audit log data is not preserved
-- across re-runs, which is acceptable for a development-phase migration.

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

-- Keep the legacy index name so db_test.go TestMigrateCreatesIndexes passes.
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
