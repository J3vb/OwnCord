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

-- An installation that is already set up records that now. A live users row
-- is the obvious evidence, but not the only one that has to count: an
-- erasure can have emptied that table before this migration ever runs, and
-- such a server must upgrade closed, not open. Two traces of a prior life
-- survive every erasure by design -- the audit rows, which are unlinked
-- rather than deleted and which the erasure adds to, and the erasure_jobs
-- row each erasure writes. A database that has none of the three has never
-- been set up.
UPDATE settings SET value = '1'
 WHERE key = 'setup_completed'
   AND (EXISTS (SELECT 1 FROM users)
     OR EXISTS (SELECT 1 FROM audit_log)
     OR EXISTS (SELECT 1 FROM erasure_jobs));
