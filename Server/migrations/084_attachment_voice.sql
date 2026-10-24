-- WP 8.9: a voice message is an ordinary attachment that also carries its
-- length and a small waveform, so a client can draw the player before it has
-- downloaded the file. duration_ms is the clip length in milliseconds
-- (1 to 300000). waveform is base64url without padding of 1 to 256 amplitude
-- bytes. Both are NULL for every other attachment, and for every row that
-- existed before this migration.
ALTER TABLE attachments ADD COLUMN duration_ms INTEGER;
ALTER TABLE attachments ADD COLUMN waveform TEXT;
