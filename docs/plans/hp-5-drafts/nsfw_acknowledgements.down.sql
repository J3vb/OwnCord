-- Rollback of the B5-7 NSFW-acknowledgement draft (migration 047).
--
-- Cost: every acknowledgement is lost. Everyone re-acknowledges every
-- labelled channel the next time they read it -- there is no way to
-- reconstruct who had already consented, so this is a one-time annoyance
-- for the whole membership, not data loss of anything the product treats
-- as durable content.
DROP TABLE IF EXISTS nsfw_acknowledgements;

DELETE FROM schema_versions WHERE version = '047_nsfw_acknowledgements.sql';
