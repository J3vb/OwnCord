-- Migration 090: indexes for the attachment lookups that scanned the table.

-- Storage reconciliation and the admin leftover scan ask which of up to 200
-- file names a row still names, and every own-upload or admin removal asks
-- whether any row names one file. Both read attachments by stored_as.
CREATE INDEX IF NOT EXISTS idx_attachments_stored_as ON attachments(stored_as);

-- The admin upload list sorts newest first by uploaded_at, then id.
CREATE INDEX IF NOT EXISTS idx_attachments_uploaded_at ON attachments(uploaded_at, id);

-- The orphan sweep reclaims the files of soft-deleted messages. This partial
-- index lists those messages so the sweep seeks their attachments by
-- message_id instead of scanning every attachment row.
CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(id) WHERE deleted = 1;
