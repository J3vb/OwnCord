-- Rollback of the report source-label migration (052).
--
-- Cost: reports lose the memory that their source channel was labelled.
-- Code that still expects the column cannot run against the result, so
-- this is only safe alongside a server version from before 052, whose
-- evidence reads do not consult it.
--
-- Order: drop the triggers before the column they write, then clear the
-- schema_versions row last.
DROP TRIGGER IF EXISTS reports_source_nsfw_on_label;
DROP TRIGGER IF EXISTS reports_source_nsfw_on_file;
ALTER TABLE reports DROP COLUMN source_nsfw;

DELETE FROM schema_versions WHERE version = '052_report_source_nsfw.sql';
