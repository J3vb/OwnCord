-- Retry receipts are committed with the message, mentions and attachment links.
-- Message/channel ids deliberately have no FK: a retention or moderation
-- deletion must not forget a key and let a retry recreate the deleted text.
-- Sender erasure removes the receipt, including its request fingerprint.
-- The timestamp embedded in client_message_id bounds validity to 24 hours.
-- Expired ids are rejected even after maintenance has removed their receipt.
CREATE TABLE message_delivery_receipts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_message_id TEXT NOT NULL,
    channel_id INTEGER NOT NULL,
    payload_hash BLOB NOT NULL,
    message_id INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, client_message_id)
);

CREATE INDEX idx_message_delivery_receipts_expiry ON message_delivery_receipts(expires_at_ms);
