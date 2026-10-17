-- Rollback of the B5-10 appeals draft (migration 050).
--
-- Cost: every open appeal is lost outright. Decided appeals are also
-- dropped, and with them the UNIQUE (action_id) memory that forbids
-- re-appealing -- once this table is gone and 050 is re-applied later, an
-- action that was already decided once can be appealed again, because
-- nothing recorded that it ever was. There is no way to reconstruct the
-- history from moderation_actions alone.
DROP INDEX IF EXISTS idx_appeals_state;
DROP TABLE IF EXISTS appeals;

DELETE FROM schema_versions WHERE version = '050_appeals.sql';
