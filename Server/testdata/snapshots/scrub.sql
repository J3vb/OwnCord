-- Identity scrub for alpha snapshots (B3-7 item 2).
--
-- Applied by `go run ./cmd/seed -profile alpha -snapshot … -scrub this-file`
-- before VACUUM INTO writes the committed snapshot, and equally applicable to
-- a REAL alpha database an operator wants to donate as a test fixture: every
-- statement is idempotent, and together they remove or replace everything
-- that identifies a person or authenticates a session. Statements are split
-- on ";" by the seed tool, so keep one statement per block and comments on
-- their own lines.

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
