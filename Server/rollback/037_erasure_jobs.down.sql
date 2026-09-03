-- Rollback of 037, from the erasure_jobs draft's own down file
-- (docs/plans/hp-4-drafts/erasure_jobs.down.sql) with the schema_versions
-- delete the draft predates. Rows describe files still to be removed: an
-- operator rolling this back while a job is not done must reconcile the
-- storage directory by hand (the B4-9 reconciliation pass lists files
-- without rows).
DROP INDEX IF EXISTS idx_erasure_jobs_state;
DROP TABLE IF EXISTS erasure_jobs;
DELETE FROM schema_versions WHERE version = '037_erasure_jobs.sql';
