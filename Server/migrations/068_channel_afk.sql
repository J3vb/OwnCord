-- AFK channel flag (WP 6.10a).
--
-- channels.afk marks the one voice channel members are parked in when they go
-- idle. The partial unique index lets the database itself enforce "at most
-- one": a second flagged row fails, so two admins racing to name different
-- AFK channels cannot leave two. Only a voice channel may carry the flag, and
-- that is checked once, at the write (the channel type cannot change after
-- creation). Deleting the row deletes the flag with it.
ALTER TABLE channels ADD COLUMN afk INTEGER NOT NULL DEFAULT 0 CHECK (afk IN (0, 1));

CREATE UNIQUE INDEX idx_channels_afk ON channels(afk) WHERE afk = 1;
