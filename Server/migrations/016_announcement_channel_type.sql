-- Allow the 'announcement' channel type.
--
-- Migration 013 added INSERT/UPDATE triggers restricting channels.type to
-- text/voice/dm, which contradicted the admin UI and specs that already
-- offered 'announcement'. Announcement channels are now a real type: readable
-- like text channels, but posting is restricted to users with MANAGE_MESSAGES
-- (enforced in the service layer). Recreate the triggers to include it.

DROP TRIGGER IF EXISTS trg_channels_type_check_insert;
DROP TRIGGER IF EXISTS trg_channels_type_check_update;

CREATE TRIGGER IF NOT EXISTS trg_channels_type_check_insert
BEFORE INSERT ON channels
FOR EACH ROW
WHEN NEW.type NOT IN ('text', 'voice', 'announcement', 'dm')
BEGIN
    SELECT RAISE(ABORT, 'invalid channel type: must be text, voice, announcement, or dm');
END;

CREATE TRIGGER IF NOT EXISTS trg_channels_type_check_update
BEFORE UPDATE OF type ON channels
FOR EACH ROW
WHEN NEW.type NOT IN ('text', 'voice', 'announcement', 'dm')
BEGIN
    SELECT RAISE(ABORT, 'invalid channel type: must be text, voice, announcement, or dm');
END;
