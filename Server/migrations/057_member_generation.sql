-- A counter bumped by every write that can change what ListMembers returns,
-- so the ready path can share one member-list read across a reconnect herd
-- and still never serve a list older than a committed join, ban, unban, role
-- change, profile edit or registration approval. It lives in SQLite, not in
-- Go, so no write path can forget it: the triggers fire for every writer,
-- raw SQL and transactions included, and commit atomically with the write.
--
-- users.status is deliberately NOT watched. Every connect stamps it, so
-- watching it would change the generation once per reconnect and no two ready
-- payloads in a herd could share a read. The hub overlays each connected
-- member's live status instead (ws/serve_ready.go presentableMembers).
CREATE TABLE IF NOT EXISTS member_generation (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    generation INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO member_generation (id, generation) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS member_generation_users_insert AFTER INSERT ON users
BEGIN
    UPDATE member_generation SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS member_generation_users_delete AFTER DELETE ON users
BEGIN
    UPDATE member_generation SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS member_generation_users_update
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

-- ListMembers renders LOWER(roles.name), so a role rename changes every
-- holder's entry without touching a users row.
CREATE TRIGGER IF NOT EXISTS member_generation_roles_rename AFTER UPDATE OF name ON roles
WHEN OLD.name IS NOT NEW.name
BEGIN
    UPDATE member_generation SET generation = generation + 1 WHERE id = 1;
END;
