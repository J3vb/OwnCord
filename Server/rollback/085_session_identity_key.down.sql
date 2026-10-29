-- Rollback of migration 085: drop the per-session identity public key.
--
-- Cost: the key each signed-in device announced is forgotten and is sent again
-- on that device's next connect. users.identity_public_key is untouched.
ALTER TABLE sessions DROP COLUMN identity_public_key;

DELETE FROM schema_versions WHERE version = '085_session_identity_key.sql';
