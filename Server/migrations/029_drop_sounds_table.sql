-- Drop the sounds table. It was created in 001_initial_schema.sql for a
-- soundboard feature that was never built: no query, model, sqlc definition,
-- route or WS handler ever referenced it, so every deployment carries it
-- empty (audit finding A-2026-07-13). The client's matching orphan API
-- methods (getSounds/deleteSound) are removed in the same change.
DROP TABLE IF EXISTS sounds;
