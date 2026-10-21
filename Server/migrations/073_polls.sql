-- Polls (WP 6.9b).
--
-- A poll is an ordinary message (kind 0) whose messages.content holds a
-- readable fallback of the question and answers. The three tables below are
-- the side rows that make it a poll.
--
-- polls holds one row per poll message. expires_at is computed from the
-- message timestamp when the poll is created. ended_at stays NULL while the
-- poll is open. version is the one denormalised value: it counts vote changes
-- and the end, so a client can order updates that arrive out of sequence.
-- Vote counts are never stored, they are always computed from poll_votes.
--
-- poll_answers holds the answers in input order, numbered from 1.
--
-- poll_votes holds one row per voter and chosen answer. A voter's rows go with
-- the account, and every row goes with its poll when the message or its
-- channel is deleted.
CREATE TABLE polls (
    message_id        INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    question          TEXT    NOT NULL,
    allow_multiselect INTEGER NOT NULL DEFAULT 0 CHECK (allow_multiselect IN (0, 1)),
    expires_at        TEXT    NOT NULL,
    ended_at          TEXT,
    version           INTEGER NOT NULL DEFAULT 0
);

-- Finds the next poll to expire without scanning the ended ones.
CREATE INDEX idx_polls_open_expiry ON polls(expires_at) WHERE ended_at IS NULL;

CREATE TABLE poll_answers (
    message_id INTEGER NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
    answer_id  INTEGER NOT NULL CHECK (answer_id BETWEEN 1 AND 10),
    text       TEXT    NOT NULL,
    emoji      TEXT,
    PRIMARY KEY (message_id, answer_id)
) WITHOUT ROWID;

CREATE TABLE poll_votes (
    message_id INTEGER NOT NULL,
    answer_id  INTEGER NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id, answer_id),
    FOREIGN KEY (message_id, answer_id) REFERENCES poll_answers(message_id, answer_id) ON DELETE CASCADE
) WITHOUT ROWID;

-- Keeps the ON DELETE CASCADE from users cheap, and serves the erasure drain.
CREATE INDEX idx_poll_votes_user ON poll_votes(user_id);
