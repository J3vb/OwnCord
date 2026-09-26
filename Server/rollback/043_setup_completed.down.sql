-- Rollback of 043. The durable flag goes away and the first-run setup gate
-- is back to its pre-043 rule, "no users exist".
--
-- That rule is why 043 was written. On a server whose users table is empty
-- the unauthenticated setup endpoint is open again, and an emptied users
-- table is a state this system can reach: a marker replay erases past the
-- last-admin guard, so a restored backup whose only account was the erased
-- owner ends with none. Do not roll 043 back on such a server without
-- closing the endpoint another way first -- the setup route is reachable
-- only from the configured setup networks, so narrowing those is the lever
-- (docs/security.md, "First-run setup").
DELETE FROM settings WHERE key = 'setup_completed';
DELETE FROM schema_versions WHERE version = '043_setup_completed.sql';
