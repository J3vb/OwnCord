-- Reply ping (WP 3A-12). A chat_send with reply_ping=true stores the replied-to
-- author as an ordinary message_mentions row flagged reply_ping = 1, so the
-- highlight, the badge and its delete reversal all read the one table. An edit
-- replaces the content-derived rows only and keeps the flagged row.
-- Rows that already exist were never reply pings, hence DEFAULT 0.
ALTER TABLE message_mentions ADD COLUMN reply_ping INTEGER NOT NULL DEFAULT 0;
