-- Rollback of the deletion-marker file's schema (Server/db/markers.go,
-- OpenMarkerStore), which the server applies on every open rather than
-- through Server/migrations -- so this file has no schema_versions row to
-- clear and reverses a file, not a migration.
--
-- Extends the deletion_markers draft's down file
-- (docs/plans/hp-4-drafts/deletion_markers.down.sql), which predates the two
-- tables the applied schema added: sequence_floors, holding the AUTOINCREMENT
-- counters the markers' tokens are computed against, and floor_probes,
-- recording that a floor was recovered by probing.
--
-- Dropping these forfeits the anti-resurrection guarantee for every erasure
-- so far: a restore of an older backup brings erased subjects back with
-- nothing left to stop them (drill D2). Deleting the file outright does the
-- same thing. An operator rolling this back records it in the server's audit
-- log first.
DROP TABLE IF EXISTS floor_probes;
DROP TABLE IF EXISTS sequence_floors;
DROP TABLE IF EXISTS deletion_markers;
