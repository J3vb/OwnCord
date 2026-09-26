-- B5-6 draft: message requests and trusted-sender relationships (BPR-060,
-- BG-13's server half, plan decisions 4 and 5).
--
-- message_requests: one row per (sender, recipient) pair EVER, not one row
-- per attempt. A re-send after an "ignored" outcome finds the existing row
-- and creates no second request and no second notification, which is what
-- makes the sender's view byte-identical across pending, ignored and
-- deleted (decision 5) -- there is only ever one row to render, in one of
-- those three states, and the sender is always told "sent".
--
-- trusted_senders: the recipient's allow-list. A row exists for exactly
-- three reasons (the "source" column), and every reason is decision 4:
--   accepted       -- the recipient accepted a pending request
--   sent_first     -- the recipient messaged the sender first, so the
--                     sender's reply is a reply, not a first-contact request
--   grandfathered  -- the pair already had a one-to-one DM at migration
--                     time, so upgrading does not interrupt a live
--                     conversation (the backfill below)
--
-- Scope: one-to-one DMs only. Group DMs are out of beta scope (decision 4)
-- and this migration does not touch group-DM membership or invitations.
--
-- Where the gate lives: service/message_crud.go's OpenDM accumulation
-- (MessageService.SendMessage calls st.OpenDM per participant and
-- accumulates result.OpenedDMFor), NOT service/dm.go's CreateDM. A gate
-- confined to CreateDM is bypassed by the sender's first message, which is
-- exactly the event this feature exists to intercept. The pending message
-- itself is stored in the DM channel as usual -- channel_id below is that
-- channel -- but the recipient's side of the conversation is not opened
-- (no dm_channel_open fan-out, no unread bump) until the request is
-- accepted -- before that it is reachable only through the request record.
--
-- Erasure: both tables name two principals (sender/recipient), so an
-- erasure of either one needs an entry in erasureStatements
-- (Server/db/erasure.go) AND in db.SubjectInventory (Server/db/inventory.go)
-- for both columns of both tables -- a table added to one list and not the
-- other is a silent pass under TestEraseAccount_EveryInventoryClassIsZero.
--
-- Deviation from the HP-5 draft (Codex review, P1-4/P2-6): the draft had no
-- first_message_id column, so both the WS creation frame and the REST inbox
-- listing derived "the held message" independently -- the frame from the
-- send's own result, the REST query from MIN(id) over the channel. Under a
-- concurrent race between two first sends only one INSERT OR IGNORE can win,
-- and nothing tied the surviving row to that winner's specific message, so
-- the two previews could name different messages, and a MIN(id) that landed
-- on an already-deleted original leaked its content into the preview forever
-- (soft delete never clears content, only sets messages.deleted). Recording
-- the id at creation, set once by whichever INSERT actually wins, makes both
-- previews the same message by construction and lets the query refuse to
-- surface it once deleted (ON DELETE SET NULL plus the query's own deleted
-- filter -- see ListPendingMessageRequests in db/queries/sqlite).
CREATE TABLE IF NOT EXISTS trusted_senders (
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source       TEXT    NOT NULL CHECK (source IN ('accepted', 'sent_first', 'grandfathered')),
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (recipient_id, sender_id)
);

CREATE TABLE IF NOT EXISTS message_requests (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    -- The message this request was created for -- set once, at creation,
    -- by whichever concurrent first send actually won the INSERT OR IGNORE
    -- below. ON DELETE SET NULL rather than CASCADE: the request survives a
    -- retention/erasure sweep of the message itself (DMs are never in
    -- retention's scope, but the column stays correct if that ever changes),
    -- and the query layer treats a NULL or deleted message the same way --
    -- no preview, not a resurrected one.
    first_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    state            TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'accepted', 'ignored', 'deleted', 'blocked')),
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    decided_at       TEXT,
    UNIQUE (sender_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_message_requests_recipient_state
    ON message_requests(recipient_id, state);

-- Grandfather every existing one-to-one DM pair as trusted, both directions,
-- so no live conversation breaks on upgrade. One-to-one only: is_group = 0
-- and channels.type = 'dm' excludes group DMs, per decision 4's scope line.
INSERT OR IGNORE INTO trusted_senders (recipient_id, sender_id, source)
SELECT p1.user_id, p2.user_id, 'grandfathered'
  FROM dm_participants p1
  JOIN dm_participants p2 ON p2.channel_id = p1.channel_id AND p2.user_id <> p1.user_id
  JOIN channels c ON c.id = p1.channel_id AND c.type = 'dm' AND c.is_group = 0;
