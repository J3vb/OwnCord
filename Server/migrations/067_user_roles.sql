-- Several roles per member. user_roles holds every role a member has, and
-- users.role_id stays as the mirror of the top role (highest position, ties
-- by lowest id). Nothing reads user_roles yet, so no permission verdict
-- changes at migration.
--
-- The backfill joins roles, so a user whose role_id names a missing role
-- (foreign keys were off historically) is skipped instead of aborting the
-- migration.
CREATE TABLE user_roles (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
) WITHOUT ROWID;

CREATE INDEX idx_user_roles_role ON user_roles(role_id, user_id);

INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, u.role_id FROM users u JOIN roles r ON r.id = u.role_id;

-- Every writer of users, Go or raw SQL, gives the new member a role row.
CREATE TRIGGER user_roles_on_user_insert AFTER INSERT ON users
BEGIN
    INSERT OR IGNORE INTO user_roles (user_id, role_id)
    SELECT NEW.id, r.id FROM roles r WHERE r.id = NEW.role_id;
END;

-- hoist: the role forms its own member-list group. Every existing role was a
-- group before this column existed, so existing roles start hoisted and new
-- roles start not hoisted. mentionable: members may ping the role.
ALTER TABLE roles ADD COLUMN hoist INTEGER NOT NULL DEFAULT 0;
ALTER TABLE roles ADD COLUMN mentionable INTEGER NOT NULL DEFAULT 0;
UPDATE roles SET hoist = 1;

CREATE TABLE message_role_mentions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, role_id)
) WITHOUT ROWID;

-- member_generation (migration 057): a role grant or revoke and a hoist or
-- colour edit all change what ListMembers renders.
CREATE TRIGGER member_generation_user_roles_insert AFTER INSERT ON user_roles
BEGIN
    UPDATE member_generation SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER member_generation_user_roles_delete AFTER DELETE ON user_roles
BEGIN
    UPDATE member_generation SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER member_generation_roles_display AFTER UPDATE OF hoist, color ON roles
WHEN OLD.hoist IS NOT NEW.hoist OR OLD.color IS NOT NEW.color
BEGIN
    UPDATE member_generation SET generation = generation + 1 WHERE id = 1;
END;
