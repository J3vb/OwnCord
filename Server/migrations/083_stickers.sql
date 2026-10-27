-- Custom stickers (WP 8.8a).
--
-- stickers is the server-wide sticker set, managed by MANAGE_SERVER holders the
-- way the emoji table is. name keeps the case it was uploaded with and is
-- unique ignoring case (COLLATE NOCASE), so "Wave" and "wave" cannot both
-- exist. emoji is the optional related emoji or custom-emoji shortcode the
-- picker searches by. filename is the storage-layer id of the image bytes, as
-- emoji.filename is. uploaded_by has no ON DELETE action, like emoji.uploaded_by:
-- account erasure moves the row to an heir (db/erasure.go erasureReassignAssets).
--
-- message_stickers is the side row that makes a message a sticker message, as
-- polls is for a poll. messages.content holds the readable fallback
-- "[Sticker: name]". sticker_id is set NULL when the sticker is deleted, and
-- name is the snapshot taken at send time, so an old message can still say
-- which sticker it was. The row goes with its message.
CREATE TABLE stickers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    emoji       TEXT,
    filename    TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE message_stickers (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    sticker_id INTEGER REFERENCES stickers(id) ON DELETE SET NULL,
    name       TEXT    NOT NULL
);

-- Serves the ON DELETE SET NULL when a sticker is deleted.
CREATE INDEX idx_message_stickers_sticker ON message_stickers(sticker_id);
