-- Per-user GIF favorites. The row stores the provider URLs and a title only,
-- never GIF bytes. A favorite follows the user across devices because it is
-- keyed by user_id, not by session. The per-user cap is enforced in
-- db.AddGIFFavorite, in the same writer transaction as the insert.
--
-- Erasure: the user half is an entry in erasureStatements
-- (Server/db/erasure.go) and db.SubjectInventory (Server/db/inventory.go).
CREATE TABLE IF NOT EXISTS gif_favorites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url         TEXT    NOT NULL,
    preview_url TEXT    NOT NULL,
    title       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, url)
);
