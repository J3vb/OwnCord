-- Migration 010: Add uploader_id to attachments for ownership checks (BUG-092).
ALTER TABLE attachments ADD COLUMN uploader_id INTEGER REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploader_id);
