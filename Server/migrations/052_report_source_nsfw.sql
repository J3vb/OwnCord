-- B5-7/B5-8 follow-up: remember whether a report's source channel was ever
-- labelled NSFW, so its evidence snapshot stays withheld after the channel
-- is deleted (its label and every acknowledgement go with it).
--
-- source_nsfw is sticky and three-valued. 1 means the source channel was
-- labelled at filing or at any time since. 0 means it never was while this
-- column existed. NULL means unknown - a report filed before this migration
-- whose channel was already gone, or one whose channel vanished between
-- intake and insert - and is withheld like 1. Reports with no source
-- channel (user targets) keep NULL and are never gated.
--
-- Two triggers keep it, so no writer of channels.nsfw or reports can skip
-- it. Unlabelling never clears it.
ALTER TABLE reports ADD COLUMN source_nsfw INTEGER;

UPDATE reports
   SET source_nsfw = (SELECT CASE WHEN c.nsfw <> 0 THEN 1 ELSE 0 END FROM channels c WHERE c.id = reports.channel_id)
 WHERE channel_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS reports_source_nsfw_on_file
AFTER INSERT ON reports
WHEN NEW.channel_id IS NOT NULL
BEGIN
    UPDATE reports
       SET source_nsfw = (SELECT CASE WHEN c.nsfw <> 0 THEN 1 ELSE 0 END FROM channels c WHERE c.id = NEW.channel_id)
     WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS reports_source_nsfw_on_label
AFTER UPDATE OF nsfw ON channels
WHEN NEW.nsfw <> 0
BEGIN
    UPDATE reports SET source_nsfw = 1 WHERE channel_id = NEW.id;
END;
