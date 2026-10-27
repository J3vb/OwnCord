-- Rollback of migration 084: drop the voice message length and waveform.
--
-- Cost: every voice message loses its length and waveform, so an older client
-- shows it as a plain audio file. The files and the attachment rows stay.
ALTER TABLE attachments DROP COLUMN waveform;
ALTER TABLE attachments DROP COLUMN duration_ms;

DELETE FROM schema_versions WHERE version = '084_attachment_voice.sql';
