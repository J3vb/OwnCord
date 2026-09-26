-- B4-9 follow-up (#1517): the replay purge is part of the erasure job.
-- replay_purged records that the erased user's frames were taken out of the
-- replay pipeline (ring buffer, persister, events rows) after the member_ban
-- broadcast, so a purge that failed is retried from the journal like the
-- files are. Rows from before this column predate the purge: their events
-- are bounded by the pruner, so they count as purged.
ALTER TABLE erasure_jobs ADD COLUMN replay_purged INTEGER NOT NULL DEFAULT 1;

-- messages.reply_to has ON DELETE SET NULL and had no index, so every message
-- the erasure deletes cost a scan of the whole table to find its replies
-- (two seconds for one member of the alpha snapshot, far worse under the
-- race detector). Its own migration, so upgraded installations get it too.
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);
