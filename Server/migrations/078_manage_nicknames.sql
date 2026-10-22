-- WP 6.4a: the MANAGE_NICKNAMES permission bit (23, 0x800000 = 8388608) lets a
-- moderator set or clear another member's nickname (users.display_name). No
-- column is added: the nickname already exists and the bit only says who other
-- than the member may write it.
--
-- Default grant, scoped like 048_reports.sql did for MODERATE_MEMBERS: only the
-- UNTOUCHED default Moderator row gets the bit. After 048 an untouched
-- Moderator holds 0x6FFFFF (7340031), and no later migration changes role 3,
-- so with bit 23 it becomes 0xEFFFFF (15728639). A Moderator role that was
-- renamed or edited gets nothing here and is granted "Manage Nicknames" by
-- hand in the role grid (docs/server-configuration.md says so).
--
-- The untouched Admin mask 0x3FFFFFFF (1073741823) already covers bit 23 and
-- the Owner (id 1) holds Administrator, so both already hold it. The second
-- statement then clears the bit from every other role, so only the intended
-- rows hold it. Nothing could have set it before: the bit was not a defined
-- permission and every role write masks unknown bits.
UPDATE roles SET permissions = permissions | 8388608
 WHERE id = 3 AND name = 'Moderator' AND permissions = 7340031;

UPDATE roles SET permissions = permissions & ~8388608
 WHERE NOT ((id = 2 AND name = 'Admin' AND permissions = 1073741823)
         OR (id = 3 AND name = 'Moderator' AND permissions = 15728639)
         OR id = 1);
