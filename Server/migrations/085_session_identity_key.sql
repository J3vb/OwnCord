-- Voice E2EE identity key per device: a session is one device's sign-in, and
-- the device keeps its own identity keypair. identity_public_key is the
-- base64 public key that device sent in its WebSocket auth frame, written on
-- every connect: the last key this session sent, not a fixed or current key
-- of the device. NULL for a session that has never connected with a key (an
-- older client), and for every row that existed before this migration.
-- users.identity_public_key is unchanged and still holds the last key
-- published through PATCH /users/me.
ALTER TABLE sessions ADD COLUMN identity_public_key TEXT;
