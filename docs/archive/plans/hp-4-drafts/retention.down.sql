-- Rollback of the B4-11 retention draft. Removing the policy stops future
-- sweeps; what earlier sweeps deleted is gone (that was the policy).
DROP TABLE IF EXISTS retention_runs;
DROP TABLE IF EXISTS channel_retention;
DELETE FROM settings WHERE key = 'retention_days';
