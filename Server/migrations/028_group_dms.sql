-- Migration 028 (phase 6, group DMs): mark which DM channels are groups.
--
-- dm_participants has always held N rows per channel, so a group DM needed no
-- new table. What it did need is a way to tell a group from a two-person DM
-- that does NOT count participants, because the count changes underneath you:
--
--   * A group of three that two people leave has two participants, and the 1:1
--     lookup in GetOrCreateDMChannel -- "the dm channel both of these users are
--     in" -- would then match it. "Message Bob" would silently deliver into the
--     remnants of a group, in front of whoever else is still there.
--   * Leaving is destructive for a group (you come out of dm_participants) and
--     non-destructive for a 1:1 (you only hide it). Deriving which one to run
--     from the live count means the third-from-last leaver runs a different
--     operation than the second-from-last, for no reason the user can see.
--
-- So group-ness is a property of the channel, decided once at creation and
-- never recomputed. is_group = 0 for every pre-existing row, which is correct:
-- every DM that existed before this migration was created by the 1:1 path.
--
-- The column lives on channels rather than a dm_groups side table because it
-- is one bit about a channel, and every read that needs it is already loading
-- the channel row.
ALTER TABLE channels ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0;

-- The 1:1 DM lookup filters on it (c.type = 'dm' AND c.is_group = 0) on every
-- "open a DM with this person", which is a hot path on the DM sidebar. Partial
-- on type so the index covers only the DM rows -- guild channels are never
-- groups and never looked up this way.
CREATE INDEX IF NOT EXISTS idx_channels_dm_group ON channels(is_group) WHERE type = 'dm';
