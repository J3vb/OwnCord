-- Rollback of migration 061: put back the 057 form of the member-generation
-- trigger, which does not watch users.about.
--
-- Cost: none for data. An older binary does not read about in the member
-- list, so it does not need the trigger to watch it.
DROP TRIGGER IF EXISTS member_generation_users_update;

CREATE TRIGGER member_generation_users_update
AFTER UPDATE OF username, avatar, role_id, banned, ban_expires, registration_status,
    identity_public_key, display_name, custom_status ON users
WHEN OLD.username IS NOT NEW.username
    OR OLD.avatar IS NOT NEW.avatar
    OR OLD.role_id IS NOT NEW.role_id
    OR OLD.banned IS NOT NEW.banned
    OR OLD.ban_expires IS NOT NEW.ban_expires
    OR OLD.registration_status IS NOT NEW.registration_status
    OR OLD.identity_public_key IS NOT NEW.identity_public_key
    OR OLD.display_name IS NOT NEW.display_name
    OR OLD.custom_status IS NOT NEW.custom_status
BEGIN
    UPDATE member_generation SET generation = generation + 1 WHERE id = 1;
END;

DELETE FROM schema_versions WHERE version = '061_member_generation_about.sql';
