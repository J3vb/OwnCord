-- WP 8.4c: the MANAGE_BACKUPS permission bit (14, 0x4000 = 16384) lets a member
-- create, list and download database backups. Data only: the bit is a value in
-- roles.permissions.
--
-- Nobody holds it after this migration except the owner. The seeded Admin
-- (0x3FFFDFFF) and Moderator (0xEFDFFF) masks carry bit 14 as an unused bit,
-- left over from before it was a defined permission, and a role that kept it
-- would gain the power to take and download a backup, which holds every
-- message and every password hash. So for every role except the owner (id 1,
-- or a position of 100 or more) the bit is cleared. The owner grants it by
-- hand in the role grid. Restore, delete and the full archive stay with the
-- owner whatever this bit says, so nothing anyone could do until now is lost.
UPDATE roles SET permissions = permissions & ~16384
 WHERE id != 1 AND position < 100;
