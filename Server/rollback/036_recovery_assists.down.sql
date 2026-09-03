-- Rollback of 036. Outstanding owner-issued recovery credentials are
-- discarded with the table, including the record of who issued each one and
-- how the person was verified. A credential already handed to a user stops
-- being redeemable, so re-issue after the rollback rather than before it.
DROP TABLE IF EXISTS recovery_assists;
DELETE FROM schema_versions WHERE version = '036_recovery_assists.sql';
