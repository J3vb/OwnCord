-- Identity and credential scrub for alpha snapshots (B3-7 item 2).
--
-- Applied by `go run ./cmd/seed -profile alpha -snapshot … -scrub this-file`
-- before VACUUM INTO writes the committed snapshot. Every statement is
-- idempotent. Scope, stated precisely (Codex on #1469): this script removes
-- account identities, credentials, session/token material, invite codes,
-- audit detail, user-chosen filenames and wall-clock apply times. It
-- DELIBERATELY DOES NOT touch message content, channel names/topics, or the
-- FTS index built from them — the committed snapshot's content is synthetic
-- lexicon text with nothing to hide, and content anonymisation of a REAL
-- database is a judgement call no blanket UPDATE can make. A donated
-- production database is NOT made shareable by this script alone: its
-- messages and channel names must be cleared or rewritten first (and the
-- FTS index rebuilt), or the donation refused. Statements are split on ";"
-- with comment lines stripped, so keep one statement per block and comments
-- on their own lines.

UPDATE users
SET username = 'user' || printf('%03d', id),
    display_name = NULL,
    about = NULL,
    custom_status = NULL,
    avatar = NULL,
    totp_secret = NULL,
    identity_public_key = NULL,
    ban_reason = CASE WHEN ban_reason IS NULL THEN NULL ELSE 'scrubbed' END,
    password = '$2a$12$EBrRXmplT1ryU0o/HzELSePreo.gK5.z5Tjo4ec/ISchy5gKwxtQq';

-- Sessions, tokens and rate-limit state authenticate or profile people —
-- a snapshot carries none of them.
DELETE FROM sessions;

DELETE FROM api_tokens;

DELETE FROM login_attempts;

DELETE FROM rate_lockouts;

-- Invite codes are shared secrets; keep the rows, rotate the codes.
UPDATE invites SET code = 'ALPHA-INV-' || printf('%02d', id);

-- Audit detail can quote user-entered text; the action skeleton is enough.
UPDATE audit_log SET detail = '';

-- Migration tracking records wall-clock apply times; the snapshot's
-- canonical form pins them to the window end so two generation runs produce
-- identical bytes (and a real donated database stops dating its operator).
UPDATE schema_versions SET applied_at = '2026-08-01 00:00:00';

-- Attachment filenames are user-chosen text.
UPDATE attachments
SET filename = 'file-' || substr(id, 1, 8) ||
               CASE
                   WHEN mime_type LIKE 'image/%' THEN '.png'
                   WHEN mime_type LIKE 'audio/%' THEN '.ogg'
                   WHEN mime_type LIKE 'video/%' THEN '.mp4'
                   ELSE '.bin'
               END;
