-- Add CHECK constraint on channels.type to prevent invalid channel types.
-- SQLite does not support ALTER TABLE ADD CONSTRAINT, so we recreate the
-- constraint via a trigger that rejects invalid types on INSERT and UPDATE.
CREATE TRIGGER IF NOT EXISTS trg_channels_type_check_insert
BEFORE INSERT ON channels
FOR EACH ROW
WHEN NEW.type NOT IN ('text', 'voice', 'dm')
BEGIN
    SELECT RAISE(ABORT, 'invalid channel type: must be text, voice, or dm');
END;

CREATE TRIGGER IF NOT EXISTS trg_channels_type_check_update
BEFORE UPDATE OF type ON channels
FOR EACH ROW
WHEN NEW.type NOT IN ('text', 'voice', 'dm')
BEGIN
    SELECT RAISE(ABORT, 'invalid channel type: must be text, voice, or dm');
END;
