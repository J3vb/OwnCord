-- Rollback of 035. Every enrolled recovery kit stops working: the row held
-- the argon2id verifier a kit secret is checked against, never the secret,
-- so there is nothing to keep and nothing recoverable. Accounts that relied
-- on a kit have no self-service recovery on a pre-035 server -- tell them
-- before rolling back, not after.
DROP TABLE IF EXISTS recovery_kits;
DELETE FROM schema_versions WHERE version = '035_recovery_kits.sql';
