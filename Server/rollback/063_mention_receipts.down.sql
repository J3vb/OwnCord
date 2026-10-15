-- Rollback of migration 063: drop the mention ledger.
--
-- Cost: the record of which messages raised each mention badge is lost.
-- Badges themselves (read_states.mention_count) are untouched. A later
-- re-apply backfills only the rows that show a badge at that moment.
DROP INDEX IF EXISTS idx_mention_receipts_message;

DROP TABLE IF EXISTS mention_receipts;

DELETE FROM schema_versions WHERE version = '063_mention_receipts.sql';
