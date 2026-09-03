-- B4-10 (Codex security review of #1522): first-run setup is
-- unauthenticated, gated only by "no users exist". Account erasure can now
-- empty that table -- a marker replay erases past the last-admin guard, so a
-- restored backup whose only user is the erased owner ends with none -- and
-- the endpoint would reopen, letting the first caller on an allowed network
-- mint an Owner. The gate becomes a durable flag instead: set once the first
-- owner is created and never cleared by the server, so an emptied user table
-- leaves setup closed. Clearing it is deliberate, local and manual: an
-- operator with filesystem access sets it back to 0 to re-open the wizard
-- (docs/security.md, "First-run setup").
INSERT OR IGNORE INTO settings (key, value) VALUES ('setup_completed', '0');

-- An installation that is already set up records that now, before any
-- erasure can empty the table.
UPDATE settings SET value = '1'
 WHERE key = 'setup_completed' AND EXISTS (SELECT 1 FROM users);
