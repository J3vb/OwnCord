-- B5-9: the moderator-action ledger appeals hang off (BPR-072, roadmap
-- workstream 10's testable half, plan decision 6). Copied verbatim from the
-- HP-5 draft (docs/plans/hp-5-drafts/moderation_actions.up.sql) -- see that
-- file's header for the full rationale (kind semantics, actor/report bare
-- ids, permission bit, retention). Reproduced here only where this
-- migration's own behaviour needs restating.
--
-- This is the action ledger, so EVERY moderator action writes a row here in
-- the same transaction as its effect -- ban, kick and removal included,
-- even though their mechanisms already exist (BanUser, ForceLogout,
-- message_purge.go) -- so an appeal always has a row to reference and
-- workstream 10's audit-coverage absence proof has a single table to check
-- against.
--
-- kind = 'warning': a notice the target must acknowledge on next connect
-- (acknowledged_at is set then, not at issue time).
--
-- kind = 'timeout': expires_at is set, and the timeout is active while
-- lifted_at IS NULL AND expires_at > now. It suppresses text and reactions
-- directly and defers its voice half to the existing MUTE_MEMBERS
-- mechanism (bit 20) rather than adding a second path to the same effect
-- (decision 6).
--
-- target_id cascades on user deletion, because S6 says the target's own
-- rows here are DELETED on erasure -- unlike reports, where the outcome
-- must survive -- and the indefinite record that survives instead is the
-- audit_log row every action also writes.
--
-- actor_id / actor_token is the bare-id-plus-token pattern (see migration
-- 048's reports table for the fuller rationale): the acting moderator's
-- identity must not be lost from the ledger just because they later erase
-- their own account. No CHECK (actor_id > 0): erasure sets actor_id to 0 for
-- an erased moderator, and a constraint would forbid that transition.
--
-- report_id is a bare integer with no foreign key. Migration 048 keeps the
-- report row itself indefinitely and prunes only its content -- evidence,
-- notes and detail -- so this column is never actually left dangling by
-- that clock. The bare id is still deliberate, for the mirror-image reason
-- reports.up.sql gives for its own bare ids: a foreign key here would make
-- any future change to how reports rows are kept a constraint this ledger
-- has to satisfy too, rather than a plain number that tolerates one either
-- way.
--
-- reason is shown to the target for warning and timeout, so it must pass
-- the audit detail denylist like every other free-text audit field -- no
-- quoted message content, bounded to 500 runes, no control characters.
--
-- Permissions: MODERATE_MEMBERS (bit 22, 0x400000) gates warning and
-- timeout -- it was already introduced by migration 048 (B5-8), granted to
-- the default Moderator role there.
--
-- Retention: expired timeouts and acknowledged warnings are retired
-- moderation.action_retention_days after expiry/acknowledgement (default
-- 90, 0 = never) unless an appeal references them. Ban, kick and removal
-- rows stay until the account itself goes -- they are not on this clock.
--
CREATE TABLE IF NOT EXISTS moderation_actions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT    NOT NULL CHECK (kind IN ('warning', 'timeout', 'removal', 'kick', 'ban')),
    target_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id        INTEGER NOT NULL DEFAULT 0,
    actor_token     TEXT,
    report_id       INTEGER,
    reason          TEXT    NOT NULL DEFAULT '',
    expires_at      TEXT,
    acknowledged_at TEXT,
    lifted_at       TEXT,
    lifted_by       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_target ON moderation_actions(target_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_timeouts
    ON moderation_actions(target_id, expires_at) WHERE kind = 'timeout' AND lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_moderation_actions_report ON moderation_actions(report_id);

-- voice_states.server_muted_by (Codex review round 4, added on this same
-- branch before release -- a SECOND 049 deviation from the HP-5 draft, not
-- a new migration, this time touching migration 002's table instead of
-- adding a column to this one): OWNERSHIP of an outstanding SFU mute moved
-- from a ledger column (moderation_actions.voice_muted, round 3's design,
-- now REMOVED -- see the HP-5 drafts README) onto the voice SESSION itself,
-- because that is the thing actually owned. A nullable FK to the
-- moderation_actions row responsible: NULL means nobody (or a manual
-- moderator mute via the existing voice-mute endpoint, which never sets
-- it), non-NULL means a timeout row.
--
-- This single relocation is what makes Codex round 3's remaining races
-- structural non-issues rather than three separate patches:
--   - inheritance from an ended session (round-3 Codex 13): a session that
--     ends (voice_states row deleted) or restarts (a fresh row, joined_at
--     changes, server_muted_by starts NULL) can never be confused with a
--     later, unrelated one -- ownership is scoped to the exact row, not
--     copied forward through a ledger column a NEW row could inherit from
--     a STALE one.
--   - the ledger write racing a concurrent lift (round-3 Codex 16): there
--     is no longer a separate "record ownership" write after the mute
--     lands -- db.MuteForTimeoutSession's single UPDATE sets server_muted=1
--     AND server_muted_by=<action id> together, only on the unmuted->muted
--     transition (WHERE server_muted = 0), so ownership can never be
--     half-applied for a concurrent lift to race.
--   - a lift needing to know which rows it may safely clear: it now runs
--     ONE statement, `UPDATE voice_states SET server_muted = 0,
--     server_muted_by = NULL WHERE user_id = ? AND server_muted_by IN
--     (<the ids just lifted>)` -- session-bound for free, and correct
--     against any supersede chain because TimeoutUser transfers ownership
--     (`UPDATE voice_states SET server_muted_by = <new id> WHERE
--     server_muted_by IN (<superseded ids>)`) in the same transaction that
--     supersedes them, so the CURRENT owner is always the row LiftTimeout
--     will actually act on.
--
-- What remains a Go-level, not schema-level, guarantee (round 4, Codex
-- 12/14): the DB transition and the paired LiveKit call are not
-- serialized by SQLite alone -- ws.Hub takes a per-target-user lock around
-- both, for the timeout path AND the manual voice-mute endpoint, so a late
-- unmute from one path cannot interleave with a fresh mute from the other,
-- and an SFU failure after a successful DB transition rolls the DB back
-- under the same lock (db.ClearServerMuteOwnedBy, the same statement the
-- lift path uses) so the two never disagree.
ALTER TABLE voice_states ADD COLUMN server_muted_by INTEGER REFERENCES moderation_actions(id) ON DELETE SET NULL;
