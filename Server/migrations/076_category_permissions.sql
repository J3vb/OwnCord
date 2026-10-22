-- Category permissions as a synced template (WP 6.5d).
--
-- A category carries a set of permission overrides that its channels can stay
-- SYNCED to. The category rows are a template that is copied onto channels
-- (writing one rewrites the same row on every synced channel, and a channel
-- created in a category starts as a copy of it). They are never consulted when
-- a permission is computed: permissions.EffectiveChannelPerms still reads only
-- channel_overrides and channel_user_overrides, so a channel's effective access
-- is always what its own rows say.
--
-- The shape mirrors channel_overrides and channel_user_overrides exactly
-- (allow/deny masks, cascade on both parents), so deleting a category drops
-- its template and deleting a role or a user drops their rows.
CREATE TABLE category_overrides (
    category_id INTEGER NOT NULL REFERENCES channel_categories(id) ON DELETE CASCADE,
    role_id     INTEGER NOT NULL REFERENCES roles(id)             ON DELETE CASCADE,
    allow       INTEGER NOT NULL DEFAULT 0,
    deny        INTEGER NOT NULL DEFAULT 0,
    UNIQUE(category_id, role_id)
);

CREATE TABLE category_user_overrides (
    category_id INTEGER NOT NULL REFERENCES channel_categories(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id)             ON DELETE CASCADE,
    allow       INTEGER NOT NULL DEFAULT 0,
    deny        INTEGER NOT NULL DEFAULT 0,
    UNIQUE(category_id, user_id)
);

-- The per-user direction ("every template row this user carries") is what an
-- account erasure walks.
CREATE INDEX idx_category_user_overrides_user ON category_user_overrides(user_id);

-- 1 while the channel's own override rows are kept equal to its category's
-- template. A direct override edit, or a move to another category without a
-- sync, sets it back to 0.
--
-- Backfill: nothing is synced. DEFAULT 0 leaves every existing channel exactly
-- as it is, and no category has a template yet, so an upgraded server keeps
-- precisely the overrides it had.
ALTER TABLE channels ADD COLUMN permissions_synced INTEGER NOT NULL DEFAULT 0;
