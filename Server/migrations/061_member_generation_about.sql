-- ListMembers now returns users.about (the About Me bio), so an about-only
-- edit changes the roster. Migration 057's trigger watches a fixed column
-- list, so re-create it with about added to both UPDATE OF and WHEN.
-- Without this a new connection could be served a stale About Me from the
-- generation-cached member list after an about-only edit.
DROP TRIGGER IF EXISTS member_generation_users_update;

CREATE TRIGGER member_generation_users_update
AFTER UPDATE OF username, avatar, role_id, banned, ban_expires, registration_status,
    identity_public_key, display_name, about, custom_status ON users
WHEN OLD.username IS NOT NEW.username
    OR OLD.avatar IS NOT NEW.avatar
    OR OLD.role_id IS NOT NEW.role_id
    OR OLD.banned IS NOT NEW.banned
    OR OLD.ban_expires IS NOT NEW.ban_expires
    OR OLD.registration_status IS NOT NEW.registration_status
    OR OLD.identity_public_key IS NOT NEW.identity_public_key
    OR OLD.display_name IS NOT NEW.display_name
    OR OLD.about IS NOT NEW.about
    OR OLD.custom_status IS NOT NEW.custom_status
BEGIN
    UPDATE member_generation SET generation = generation + 1 WHERE id = 1;
END;
