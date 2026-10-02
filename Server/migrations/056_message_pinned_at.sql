-- Order the pinned-messages panel by pin recency, not message id. The panel
-- previously ordered by m.id DESC, so an old message pinned after a newer one
-- appeared at the bottom, contradicting the query's own doc comment. NULL means
-- "pin time unknown" for rows pinned before this migration, and those sort
-- last. A fresh pin stamps the row.
ALTER TABLE messages ADD COLUMN pinned_at TEXT;
