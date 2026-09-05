-- B5-9 draft: the moderator-action ledger appeals hang off (BPR-072,
-- roadmap workstream 10's testable half, plan decision 6).
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
-- actor_id / actor_token is the bare-id-plus-token pattern (see the
-- reports draft, migration 048, for the fuller rationale): the acting
-- moderator's identity must not be lost from the ledger just because they
-- later erase their own account.
--
-- report_id is a bare integer with no foreign key, so a report pruned by
-- its own 180-day evidence retention (migration 048) leaves a plain number
-- here rather than a dangling foreign key or a cascade that would delete
-- the action along with the report.
--
-- reason is shown to the target for warning and timeout, so it must pass
-- the audit detail denylist like every other free-text audit field --
-- no quoted message content.
--
-- Permissions: a new bit, MODERATE_MEMBERS = bit 22 (0x400000), gates
-- warning and timeout. It stays OUT of AdminPerimeter (a warning-only
-- moderator must not inherit the whole operator perimeter) and is granted
-- to the Moderator role by default. Four files change for this bit alone:
-- permissions.go (the constant), admin/static/index.html (PERM_GROUPS),
-- Client/src/lib/types.ts (the Permission enum) and docs/schema.md (the
-- bit map, which currently lists 22-23 as reserved).
--
-- Retention: expired timeouts and acknowledged warnings are retired 90
-- days later on the maintenance tick unless an appeal references them
-- (moderation.action_retention_days, default 90, 0 = never). Ban, kick and
-- removal rows stay until the account itself goes -- they are not on this
-- clock.
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
