-- B4-9: complete account erasure (BPR-052, BG-11).
-- The database half of an erasure is one transaction (data-lifecycle O1
-- A1) and the file half (attachment blobs, the avatar) cannot be, so it is
-- journaled here and resumed at startup and on every maintenance tick until
-- every file is gone. The row outlives the subject: user_id is a bare
-- integer, not a foreign key, because the users row is hard-deleted by the
-- same transaction that writes it.
CREATE TABLE erasure_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    -- queued: accepted, nothing done yet
    -- db_done: the database transaction committed, files listed below remain
    -- done: every listed file is gone or was never there
    state         TEXT    NOT NULL CHECK (state IN ('queued', 'db_done', 'done')),
    -- JSON array of stored_as names captured inside the transaction, before
    -- the attachment rows were deleted: the only surviving handle on the blobs.
    files         TEXT    NOT NULL DEFAULT '[]',
    files_removed INTEGER NOT NULL DEFAULT 0,
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    finished_at   TEXT
);
CREATE INDEX idx_erasure_jobs_state ON erasure_jobs(state) WHERE state <> 'done';
