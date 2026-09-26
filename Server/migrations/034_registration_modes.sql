-- B4-1 (BPR-041, BG-10): registration modes replace the registration_open
-- boolean. A fresh install (no users yet) defaults to invite-only. An upgrade
-- keeps the owner's choice without ever opening registration: 1 becomes
-- invite (an invite was always required), anything else becomes closed.
INSERT OR IGNORE INTO settings (key, value)
SELECT 'registration_mode',
       CASE
         WHEN NOT EXISTS (SELECT 1 FROM users) THEN 'invite'
         WHEN (SELECT value FROM settings WHERE key = 'registration_open') IN ('1', 'true', 'TRUE', 'True') THEN 'invite'
         ELSE 'closed'
       END;
DELETE FROM settings WHERE key = 'registration_open';
-- Approval mode: an application is an account that exists but cannot sign in
-- until an admin approves it (pending -> active). Denial anonymises the row
-- and locks it for good (denied), the same convention account deletion uses,
-- because audit rows reference the user id.
ALTER TABLE users ADD COLUMN registration_status TEXT NOT NULL DEFAULT 'active';
