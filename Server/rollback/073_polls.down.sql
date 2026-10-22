-- Rollback of migration 073: drop the poll side rows.
--
-- Cost: every poll and its votes are lost. Each poll message stays in its
-- channel as an ordinary message by its author, showing the question and the
-- answers as plain text, and can be edited again. Nothing else is lost.
DROP INDEX IF EXISTS idx_poll_votes_user;
DROP TABLE IF EXISTS poll_votes;
DROP TABLE IF EXISTS poll_answers;
DROP INDEX IF EXISTS idx_polls_open_expiry;
DROP TABLE IF EXISTS polls;

DELETE FROM schema_versions WHERE version = '073_polls.sql';
