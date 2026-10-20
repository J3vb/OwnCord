-- Private profile notes and profile banners (WP 6.11a).
--
-- user_notes holds one private note per (owner, target). Every read and write
-- is keyed by the session user as owner. Erasing either user removes the row.
--
-- users.banner_id and users.banner_color are the profile banner. They land
-- here with the notes so one migration covers the work package, and stay unused
-- until the banner endpoints arrive in 6.11b. banner_id names an unlinked
-- attachment, kept alive while it is named, the same shape as channels.dm_icon.
ALTER TABLE users ADD COLUMN banner_id TEXT REFERENCES attachments(id) ON DELETE SET NULL;

ALTER TABLE users ADD COLUMN banner_color TEXT;

CREATE INDEX idx_users_banner_id ON users(banner_id) WHERE banner_id IS NOT NULL;

CREATE TABLE user_notes (
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note       TEXT    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (owner_id, target_id)
) WITHOUT ROWID;

CREATE INDEX idx_user_notes_target ON user_notes(target_id);

-- The member list is cached by member_generation and ListMembers will carry the
-- banner, so re-create the 061 trigger with banner_id and banner_color added to
-- both UPDATE OF and WHEN.
DROP TRIGGER IF EXISTS member_generation_users_update;

CREATE TRIGGER member_generation_users_update
AFTER UPDATE OF username, avatar, role_id, banned, ban_expires, registration_status,
    identity_public_key, display_name, about, custom_status, banner_id, banner_color ON users
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
    OR OLD.banner_id IS NOT NEW.banner_id
    OR OLD.banner_color IS NOT NEW.banner_color
BEGIN
    UPDATE member_generation SET generation = generation + 1 WHERE id = 1;
END;
