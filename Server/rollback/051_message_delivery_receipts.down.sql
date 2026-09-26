-- Receipt removal loses retry memory. Recovered pending drafts require
-- deliberate review against existing history before resending.
-- Existing messages and attachments are unchanged.
DROP TABLE IF EXISTS message_delivery_receipts;
DELETE FROM schema_versions WHERE version = '051_message_delivery_receipts.sql';
