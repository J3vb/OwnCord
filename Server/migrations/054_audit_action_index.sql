-- PERF-09: the admin Dashboard's action filter runs
-- SELECT DISTINCT action FROM audit_log, and the log grows without bound (one
-- ws_connect row per WebSocket handshake, never pruned). Without this index
-- every Dashboard load scans the whole table. The index lets SQLite satisfy
-- the DISTINCT from the index alone.
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
