-- Rollback of 039, from the retention draft's own down file with the
-- schema_versions delete added. Removing the policy stops future sweeps.
-- What earlier sweeps deleted is gone, which was the policy. Dropping
-- retention_runs takes purge_pending with it, so a sweep whose replay purge
-- had not finished loses its journal -- let the retention service settle
-- before rolling back.
DROP TABLE IF EXISTS retention_runs;
DROP TABLE IF EXISTS channel_retention;
DELETE FROM settings WHERE key = 'retention_days';
DELETE FROM schema_versions WHERE version = '039_retention.sql';
