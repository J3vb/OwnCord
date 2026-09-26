-- Rollback of the B4-10 marker draft. Dropping the table forfeits the
-- anti-resurrection guarantee for every erasure so far: a restore of an
-- older backup would bring erased subjects back with nothing to stop it
-- (the state drill D2 records). An operator rolling back must say so in the
-- server's own audit log first.
DROP TABLE IF EXISTS deletion_markers;
