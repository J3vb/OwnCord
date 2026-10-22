-- Rollback of migration 073 (data-only): nothing to undo.
--
-- Cost: none. 073 only made user_roles agree with users.role_id, and an older
-- binary reads users.role_id, which 073 changed only for a member whose role
-- had been deleted (they were moved to the default role).
DELETE FROM schema_versions WHERE version = '077_user_roles_reconcile.sql';
