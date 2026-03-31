-- Phase 5b: Voice optimization — add camera/screenshare tracking and
-- per-channel voice configuration for the Pion SFU.
ALTER TABLE voice_states ADD COLUMN camera INTEGER NOT NULL DEFAULT 0;
ALTER TABLE voice_states ADD COLUMN screenshare INTEGER NOT NULL DEFAULT 0;

ALTER TABLE channels ADD COLUMN voice_max_users INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN voice_quality TEXT;
ALTER TABLE channels ADD COLUMN mixing_threshold INTEGER;
ALTER TABLE channels ADD COLUMN voice_max_video INTEGER NOT NULL DEFAULT 25;
