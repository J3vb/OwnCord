-- Phase 2 (moderation depth): moderator-imposed voice state.
-- server_muted / server_deafened are distinct from the self-service muted /
-- deafened columns: only a MUTE_MEMBERS holder may clear them, and while set
-- the user's own voice_mute / voice_deafen unmute attempts are refused.
ALTER TABLE voice_states ADD COLUMN server_muted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE voice_states ADD COLUMN server_deafened INTEGER NOT NULL DEFAULT 0;
