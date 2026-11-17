-- Migration 094: server-side link previews.
--
-- The server fetches a link once after a message is sent and keeps the card
-- text here, with a shrunk thumbnail on disk named by its hash. link_previews
-- is keyed by the hash of the normalised URL, so one fetch serves every
-- message that carries the link.

CREATE TABLE IF NOT EXISTS link_preview_images (
    hash         TEXT    PRIMARY KEY,
    mime_type    TEXT    NOT NULL,
    size         INTEGER NOT NULL,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    created_at   TEXT    NOT NULL,
    last_used_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_link_preview_images_last_used ON link_preview_images(last_used_at);

-- failure is NULL for a preview that was fetched, else the spelling of the
-- failure that ended the fetch. A deleted image row leaves the preview text.
CREATE TABLE IF NOT EXISTS link_previews (
    url_hash     TEXT PRIMARY KEY,
    url          TEXT NOT NULL,
    title        TEXT,
    description  TEXT,
    site_name    TEXT,
    image_hash   TEXT REFERENCES link_preview_images(hash) ON DELETE SET NULL,
    fetched_at   TEXT NOT NULL,
    failure      TEXT,
    last_used_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_link_previews_image ON link_previews(image_hash) WHERE image_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_link_previews (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    url_hash   TEXT    NOT NULL REFERENCES link_previews(url_hash),
    PRIMARY KEY (message_id, position)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_message_link_previews_url ON message_link_previews(url_hash);

-- One row per message that has been unfurled, with or without links.
-- content_version is the message's edited_at, or its timestamp when it was
-- never edited, as the unfurl saw it. A different value now means the result
-- is stale.
CREATE TABLE IF NOT EXISTS message_unfurls (
    message_id      INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    unfurled_at     TEXT    NOT NULL,
    content_version TEXT    NOT NULL
);

-- A soft delete keeps the messages row, so the cascade does not fire. The
-- links go with the delete, in the same statement.
CREATE TRIGGER IF NOT EXISTS messages_link_previews_softdelete
AFTER UPDATE OF deleted ON messages
WHEN NEW.deleted = 1 AND OLD.deleted = 0
BEGIN
    DELETE FROM message_link_previews WHERE message_id = NEW.id;
    DELETE FROM message_unfurls WHERE message_id = NEW.id;
END;
