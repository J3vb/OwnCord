-- Reconcile user_roles with users.role_id. Builds that ran between migration
-- 067 and the role-composition work wrote only the users.role_id mirror when
-- an admin changed a member's role, and deleting a role removed its user_roles
-- rows while only the mirror was moved. Either left a member whose user_roles
-- set is not exactly the one role the mirror names, or holding no row at all.
-- Nothing could grant a second role until now, so the mirror is the truth.
--
-- A user whose role_id names a missing role gets the default role and the
-- mirror follows. With no default role such a user is left untouched.
UPDATE users
SET role_id = (SELECT id FROM roles WHERE is_default = 1 ORDER BY position DESC, id ASC LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = users.role_id)
  AND EXISTS (SELECT 1 FROM roles WHERE is_default = 1);

DELETE FROM user_roles
WHERE EXISTS (
        SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = user_roles.user_id)
  AND role_id <> (SELECT u.role_id FROM users u WHERE u.id = user_roles.user_id);

INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u JOIN roles r ON r.id = u.role_id;
