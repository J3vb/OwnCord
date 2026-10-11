-- Rollback of migration 059.
--
-- Cost: every user loses their saved GIF favorites. They are a convenience
-- list of provider URLs, so nothing durable is lost, but they cannot be
-- reconstructed.
DROP TABLE IF EXISTS gif_favorites;

DELETE FROM schema_versions WHERE version = '059_gif_favorites.sql';
