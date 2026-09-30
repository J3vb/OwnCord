-- Rollback of the member generation counter (057).
--
-- Additive only: the triggers and the counter row feed the ready path's
-- shared member-list read and nothing else. An older binary does not read
-- them, and dropping them loses no user data.
DROP TRIGGER IF EXISTS member_generation_roles_rename;
DROP TRIGGER IF EXISTS member_generation_users_update;
DROP TRIGGER IF EXISTS member_generation_users_delete;
DROP TRIGGER IF EXISTS member_generation_users_insert;
DROP TABLE IF EXISTS member_generation;

DELETE FROM schema_versions WHERE version = '057_member_generation.sql';
