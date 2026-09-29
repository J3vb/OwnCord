-- Invite redemption tracking (O1, theme 4): invites.redeemed_by is never
-- written, so a leaked invite could not be traced to the account that spent
-- it. A single column cannot hold a multi-use invite's redeemers either, so
-- each redemption is its own row.
--
-- user_id is a bare nullable integer with NO foreign key, the reports pattern
-- (048): an account erasure must leave the redemption row (and the invite's
-- use_count) intact while cutting the link, so erasure sets user_id = NULL
-- rather than deleting the history or blocking the users delete. The redeemer
-- is therefore joined from users at read time, and a redeemed-by link to an
-- erased account reads back as unknown. invite_id DOES cascade from invites:
-- an erasure deletes the subject's invites (class 15), and their redemption
-- rows are part of those invites.
CREATE TABLE IF NOT EXISTS invite_redemptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    invite_id   INTEGER NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
    user_id     INTEGER,
    redeemed_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invite_redemptions_invite ON invite_redemptions(invite_id, id);
CREATE INDEX IF NOT EXISTS idx_invite_redemptions_user   ON invite_redemptions(user_id);
