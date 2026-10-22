-- Rollback of migration 067: drop the several-roles-per-member storage.
--
-- Cost: a member who holds more than one role keeps only the role in
-- users.role_id, which migration 067 mirrors from the top held role, so an
-- older binary sees the same top role the member had. The extra roles, the hoist
-- and mentionable flags and the recorded role pings are lost.
DROP TRIGGER IF EXISTS member_generation_roles_display;
DROP TRIGGER IF EXISTS member_generation_user_roles_delete;
DROP TRIGGER IF EXISTS member_generation_user_roles_insert;
DROP TRIGGER IF EXISTS user_roles_on_user_insert;

DROP TABLE IF EXISTS message_role_mentions;
DROP INDEX IF EXISTS idx_user_roles_role;
DROP TABLE IF EXISTS user_roles;

ALTER TABLE roles DROP COLUMN mentionable;
ALTER TABLE roles DROP COLUMN hoist;

DELETE FROM schema_versions WHERE version = '067_user_roles.sql';
