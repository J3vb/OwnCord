-- Rollback of 034. registration_open is derived back from the mode. Only
-- invite can have come from a true boolean, because 034 mapped 1 to invite
-- and everything else to closed, so invite restores 1 and every other mode
-- restores 0.
--
-- The mapping is not reversible in the other direction and this is where the
-- choice is lost: a fresh install also defaulted to invite, and approval and
-- open have no boolean spelling at all. An operator running approval or open
-- comes back on a server whose registration is shut, which is safe but is
-- not what they had configured. Note the mode before rolling back.
--
-- Accounts still waiting for approval, and accounts a denial anonymised,
-- lose the status that marked them. A pre-034 server has no notion of either,
-- so a pending account becomes an ordinary account that can sign in. Approve
-- or delete every non-active account before rolling back.
INSERT OR REPLACE INTO settings (key, value)
SELECT 'registration_open',
       CASE WHEN (SELECT value FROM settings WHERE key = 'registration_mode') = 'invite'
            THEN '1'
            ELSE '0'
       END;
DELETE FROM settings WHERE key = 'registration_mode';
ALTER TABLE users DROP COLUMN registration_status;
DELETE FROM schema_versions WHERE version = '034_registration_modes.sql';
