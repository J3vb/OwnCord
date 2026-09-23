-- RI-08: every policy writer, including channel cascade deletion, invalidates
-- previews. A monotonic revision also detects A -> B -> A within one second.
CREATE TABLE retention_revision (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0)
);
INSERT INTO retention_revision VALUES (1, 0);

CREATE TRIGGER retention_server_insert AFTER INSERT ON settings WHEN NEW.key = 'retention_days'
BEGIN
    UPDATE retention_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER retention_server_update AFTER UPDATE ON settings WHEN OLD.key = 'retention_days' OR NEW.key = 'retention_days'
BEGIN
    UPDATE retention_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER retention_server_delete AFTER DELETE ON settings WHEN OLD.key = 'retention_days'
BEGIN
    UPDATE retention_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER retention_channel_insert AFTER INSERT ON channel_retention
BEGIN
    UPDATE retention_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER retention_channel_update AFTER UPDATE ON channel_retention
BEGIN
    UPDATE retention_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER retention_channel_delete AFTER DELETE ON channel_retention
BEGIN
    UPDATE retention_revision SET revision = revision + 1 WHERE id = 1;
END;
