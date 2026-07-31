-- Migration 019: performance indexes + FTS trigger scope fix.

-- Attachments are batch-fetched per message page. Without an index on
-- message_id every page load scans the whole attachments table.
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

-- GetAllChannelPermissionsForRole looks up overrides by role_id, which the
-- (channel_id, role_id) UNIQUE auto-index cannot serve. The covering index
-- includes allow/deny so the lookup never touches the table. The old
-- idx_channel_overrides_channel_role (migration 006) exactly duplicated the
-- UNIQUE auto-index, so it only cost write time — drop it.
CREATE INDEX IF NOT EXISTS idx_channel_overrides_role
    ON channel_overrides(role_id, channel_id, allow, deny);
DROP INDEX IF EXISTS idx_channel_overrides_channel_role;

-- Pinned-message listing seeks this partial index instead of scanning the
-- channel's whole history.
CREATE INDEX IF NOT EXISTS idx_messages_pinned
    ON messages(channel_id, id DESC) WHERE pinned = 1 AND deleted = 0;

-- The original messages_au trigger fired on EVERY update, so pinning or
-- soft-deleting a message paid for a full FTS delete+reinsert even though the
-- content was unchanged. Scope it to content updates only — the single case
-- that actually needs a reindex (message edits).
DROP TRIGGER IF EXISTS messages_au;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
