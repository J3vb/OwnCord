-- Rollback of migration 069: drop private notes and the banner columns.
--
-- Cost: every private note is lost, and every banner colour and banner image
-- link is forgotten. Banner image files stay in the attachments table as
-- unlinked rows that the orphan sweep reclaims. The trigger goes first because
-- it names the columns about to be dropped, and comes back in its 061 form.
DROP TRIGGER IF EXISTS member_generation_users_update;

DROP INDEX IF EXISTS idx_user_notes_target;
DROP TABLE IF EXISTS user_notes;

DROP INDEX IF EXISTS idx_users_banner_id;
ALTER TABLE users DROP COLUMN banner_color;
ALTER TABLE users DROP COLUMN banner_id;

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

DELETE FROM schema_versions WHERE version = '069_profile_notes_banners.sql';
