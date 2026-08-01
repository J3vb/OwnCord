-- Phase 6 (profiles & presence depth): the three profile columns the users
-- table never had, plus the index that makes avatar-file authorization cheap.
--
-- display_name is a *display* handle only. It is nullable and falls back to
-- username everywhere, and mentions keep resolving against username alone --
-- username is the unique, case-insensitive key, so making @mentions look at a
-- non-unique nickname would make "@alice" ambiguous the moment two people pick
-- the same one.
--
-- Bounds (1-32 for display_name, 300 for about, 128 for custom_status) are
-- enforced in the service layer, which is where the sanitizer runs and where a
-- violation can answer 400 instead of a constraint error. The columns are
-- plain TEXT so a future bound change is not a table rebuild.
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN about TEXT;
ALTER TABLE users ADD COLUMN custom_status TEXT;

-- Avatars uploaded through POST /api/v1/users/me/avatar land in the attachments
-- table with no channel, and an unlinked attachment is readable only by its
-- uploader -- which would make every avatar invisible to everyone but its
-- owner. The file route therefore also admits an unlinked attachment that some
-- user's avatar column currently points at: an avatar is readable exactly while
-- it is somebody's avatar, and stops being readable the moment it is replaced.
--
-- That check is an equality lookup on users.avatar on every avatar fetch, so it
-- gets an index. Partial (avatar IS NOT NULL) because the rows that matter are
-- the ones with a value and the default is NULL.
CREATE INDEX IF NOT EXISTS idx_users_avatar ON users(avatar) WHERE avatar IS NOT NULL;
