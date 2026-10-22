-- Real channel categories (WP 6.5a).
--
-- A category was free text on every channel (channels.category). It becomes a
-- row of its own, so a rename is one write, an order exists independent of the
-- channels in it, and an empty category can exist. channels.category_id points
-- at it and goes NULL when the category is deleted, so deleting one never
-- deletes a channel.
CREATE TABLE channel_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One category per name, ignoring ASCII case, the same rule the unique name
-- check on channels has always applied.
CREATE UNIQUE INDEX idx_channel_categories_name ON channel_categories(name COLLATE NOCASE);

ALTER TABLE channels ADD COLUMN category_id INTEGER REFERENCES channel_categories(id) ON DELETE SET NULL;

-- Keeps the ON DELETE SET NULL above cheap and serves the per-category reads.
CREATE INDEX idx_channels_category_id ON channels(category_id);

-- Backfill: one category per distinct trimmed non-empty channels.category,
-- compared ignoring case. The category keeps the spelling of its lowest
-- positioned channel (ties by id), and its position is the rank of that
-- channel, so the first render after the upgrade looks identical to before.
-- A channel whose category is empty or only whitespace gets no category.
INSERT INTO channel_categories (name, position)
SELECT name, ROW_NUMBER() OVER (ORDER BY position ASC, id ASC) - 1
FROM (
    SELECT name, position, id,
           ROW_NUMBER() OVER (PARTITION BY name COLLATE NOCASE ORDER BY position ASC, id ASC) AS rn
    FROM (
        SELECT id, position, trim(category, char(32, 9, 10, 11, 12, 13)) AS name
        FROM channels
        WHERE category IS NOT NULL
    )
    WHERE name <> ''
)
WHERE rn = 1
ORDER BY position ASC, id ASC;

UPDATE channels
SET category_id = (
    SELECT cc.id FROM channel_categories cc
    WHERE cc.name = trim(channels.category, char(32, 9, 10, 11, 12, 13)) COLLATE NOCASE
)
WHERE category IS NOT NULL;

-- channels.category is NOT dropped. Nothing reads or writes it after this
-- migration (every reader joins channel_categories, every writer sets
-- category_id), so it is dead weight kept for one reason: the reversal in
-- Server/rollback must return the schema exactly, and a column cannot be put
-- back at its old place in the table without rebuilding channels, which drops
-- the table and so cascades into messages under foreign_keys=ON. A later
-- migration drops the column once the rollback window for 072 has passed.
