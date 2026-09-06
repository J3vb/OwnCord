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
-- voice_muted (Codex review, added on this same branch before release --
-- a 049 deviation from the HP-5 draft, not a new migration): means
-- OWNERSHIP of an outstanding SFU mute, never merely "we called mute". 1
-- only for a genuine unmuted->muted transition THIS row caused (the target
-- was in a voice channel the actor's channel-level authorization covered,
-- P1-3, and the SFU accepted the write, P3-14) -- 0 when the target was
-- already server-muted by someone/something else (P1-4 PARTIAL: applying a
-- mute that was already in effect is not this row's mute to later clear),
-- when the row is not a timeout at all, or when ownership could not be
-- recorded before a concurrent lift won the race (compensated by an
-- immediate unmute instead, P2 16). LiftTimeout reads it to decide whether
-- clearing the SFU mute on lift is this row's business at all:
-- unconditionally clearing on every lift would undo a mute a DIFFERENT
-- moderator applied (voice_mod_mute) or one this timeout never actually
-- set. Superseding an active row transfers its voice_muted onto the new
-- row (P2 17): superseding never touches the SFU, so a mute an earlier
-- timeout owns is still live regardless, and ownership of eventually
-- clearing it must follow whichever row LiftTimeout will act on next, or a
-- later lift would see only the replacement's own (possibly 0) value and
-- strand it.
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
    voice_muted     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_target ON moderation_actions(target_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_timeouts
    ON moderation_actions(target_id, expires_at) WHERE kind = 'timeout' AND lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_moderation_actions_report ON moderation_actions(report_id);
