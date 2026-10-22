-- Rollback of migration 079: every thread follow is forgotten.
--
-- Cost: who followed which thread. Threads, messages and access are untouched,
-- since a follow never granted or limited anything. After a re-apply nobody
-- follows any thread, and each user is joined again by posting in a thread,
-- being mentioned in it, or following it.
DROP TRIGGER IF EXISTS trg_thread_members_shape_insert;

DROP INDEX IF EXISTS idx_thread_members_user;

DROP TABLE IF EXISTS thread_members;

DELETE FROM schema_versions WHERE version = '079_thread_members.sql';
