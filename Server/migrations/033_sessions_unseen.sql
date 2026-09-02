-- B4-7 (BG-08): the new-login signal. A session created by a login starts
-- unseen and stays so until the account lists its sessions from another
-- device, which acknowledges it. Rows that exist before this migration are
-- already seen.
ALTER TABLE sessions ADD COLUMN unseen INTEGER NOT NULL DEFAULT 0;
