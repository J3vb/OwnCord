-- Add the long-term E2EE identity public key to users (F3 voice E2EE TOFU).
--
-- Clients generate an ECDSA P-256 identity keypair on first login, publish the
-- public key here via the profile endpoint, and peers pin it on first sight
-- (trust-on-first-use). The key signs ephemeral voice_e2ee_announce keys so a
-- malicious server cannot swap user_id <-> ephemeral pubkey. Nullable TEXT
-- (base64), mirroring totp_secret: NULL = no key published (legacy client).

ALTER TABLE users ADD COLUMN identity_public_key TEXT;
