-- Message forwarding (WP 6.9a).
--
-- A forward is an ordinary message (kind 0) that carries a snapshot of another
-- message's text in messages.content and its files as attachment rows of its
-- own. message_forwards is the one side row that marks it as a forward and
-- remembers where it came from.
--
-- source_message_id is the original message, kept only while it exists. It goes
-- NULL when the original is purged (retention, erasure) or its channel is
-- deleted, so the jump link is never dead. A soft delete leaves the id in
-- place and the reader hides the link instead. source_channel_id has no key:
-- it is only shown while source_message_id is set, and a forward of a forward
-- keeps the original's fields, so nothing nests. No author is stored, by
-- design, so a snapshot never names a blocked or erased user.
CREATE TABLE message_forwards (
    message_id        INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    source_channel_id INTEGER NOT NULL,
    source_timestamp  TEXT    NOT NULL
);

-- Keeps the ON DELETE SET NULL above cheap when an original is purged.
CREATE INDEX idx_message_forwards_source ON message_forwards(source_message_id);
