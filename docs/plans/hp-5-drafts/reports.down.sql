-- Rollback of the B5-8 report-intake draft (migration 048).
--
-- Cost: the queue and every outcome are gone, including the unlinkable
-- outcome rows decision 7 exists to keep. A report about an account that
-- has since erased carries the last durable trace that the report ever
-- happened -- dropping this table drops that trace along with everything
-- else, which is a real loss and not merely inconvenient. Drop in child-to-
-- parent order so the foreign keys never point at a table that is already
-- gone mid-rollback.
DROP TABLE IF EXISTS report_notes;
DROP TABLE IF EXISTS report_evidence;
DROP TABLE IF EXISTS reports;

DELETE FROM schema_versions WHERE version = '048_reports.sql';
