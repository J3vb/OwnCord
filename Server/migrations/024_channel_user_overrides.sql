-- Phase 5 (channel management): per-user channel permission overrides.
--
-- channel_overrides answers "what may this ROLE do here". Discord's resolution
-- order has a second, narrower layer on top of it — a single member can be
-- granted or refused a bit in one channel without minting a role for them:
--
--     base role permissions -> role override -> user override
--
-- with the user layer applied last, so a user deny beats a role allow and a
-- user allow beats a user deny (ADMINISTRATOR still bypasses everything).
--
-- The shape mirrors channel_overrides exactly (allow/deny masks, cascade on
-- both parents) so the two layers can be fetched and merged by the same code
-- paths. The PRIMARY KEY replaces channel_overrides' surrogate id plus UNIQUE
-- pair because nothing references an override row by id.
CREATE TABLE IF NOT EXISTS channel_user_overrides (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
);

-- The per-user direction ("every override this user carries") is the one the
-- permission cache populates from on every connect. The PK only covers the
-- per-channel direction.
CREATE INDEX IF NOT EXISTS idx_channel_user_overrides_user
    ON channel_user_overrides(user_id);
