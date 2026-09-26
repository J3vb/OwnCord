-- Rollback of the B4-9 erasure-job draft. Rows describe files still to be
-- removed: an operator rolling this back while a job is not 'done' must
-- reconcile the storage directory by hand (the B4-9 reconciliation pass
-- lists files without rows).
DROP INDEX IF EXISTS idx_erasure_jobs_state;
DROP TABLE IF EXISTS erasure_jobs;
