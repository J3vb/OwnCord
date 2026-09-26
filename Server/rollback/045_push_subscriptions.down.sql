-- Rollback of 045. Every stored Web Push subscription is gone: every device
-- that opted in must re-subscribe from the client. Nothing dispatched to
-- them (B5-4 stores only, B5-11 is behind HP-5), so this loses no delivery
-- in flight -- only the record of who asked to be pushed to.
DROP TABLE IF EXISTS push_subscriptions;
DELETE FROM schema_versions WHERE version = '045_push_subscriptions.sql';
