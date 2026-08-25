# Audit 2026-08-19 Remediation — Phased Plan

**Status:** in progress — phases 1–6 landed 2026-08-20 (merged as `03fcb7d5`,
PR #1396); **phase 7 is still pending**. Phases execute in order; each phase's
status is updated in place when it lands, so the table below is authoritative
for per-phase state. Indexed in [README.md](README.md).
**Source:** [audit-2026-08-19.md](../audit-2026-08-19.md) — this plan executes
its §8 MUST-fix verdict and §9.1 fix order verbatim. Items outside that list
(§6 DEBT beyond D-01..D-05, §9.2 alpha-exit work) are deliberately NOT in
scope here; they stay tracked by the audit.
**Branch/PR:** `claude/repo-health-audit-s0xnyo` (restarted from `main` after
the audit-report PR #1395 merged), one commit per phase, single PR to `main`.

## Phases

| # | Closes | Change | Verification | Status |
|---|--------|--------|--------------|--------|
| 1 | F-5 | Give the `renderWindow >30-in-2s breaker` test in `tests/unit/message-list.test.ts` an explicit timeout so CI under load cannot produce a spurious red (it performs 30 synchronous 100-row jsdom rebuilds inside vitest's default 5 s) | run the file 3× | done 2026-08-20 |
| 2 | B-01..B-10, D-01..D-05 | Reference-doc refresh: schema.md (migrations 030/031, attachments `ON DELETE SET NULL`, index inventory, pool split, default-roles snapshot, dbgen preamble), protocol.md (DM/plugin_broadcast seq + replay tiers, retry_after, five "None" rate limits, E2EE prose + inner per-target cap, missing error codes, ready/member_join field gaps), api.md (diagnostics auth/limiter/example, error-code table, body-cap exemptions, identity_public_key, plugin text errors + header, /health 503, CIDR keys, restart-conflict 409s); stale comments (`serve_ready.go` buildReady, `tsconfig.e2e.json` + `ci.yml` spec counts, `logctx.go` stray word); three stale plan headers (bug-detection-improvements, security-scan-2026-07-22-remediation, discord-parity) | every edit re-checked against the cited code | done 2026-08-20 |
| 3 | F-3, F-4, D-16 | `slog.Warn` on the discarded errors: lockout Upsert/Delete/Cleanup (`auth/ratelimit.go`), `EvictOldestSessions` in `CreateSession` (`db/auth_queries.go`), `UpdateReadState` in `HandleChannelFocus` (`service/channel.go`) — mirrors the shipped OC-0061 pattern; in-memory behavior unchanged | unit tests pin the warn-and-continue contract | done 2026-08-20 |
| 4 | F-1 | Blocking a user evicts them from the pair's live 1:1 DM voice call via the existing `dmVoiceEvictor` seam `CloseDM` already exercises (group DMs stay exempt, matching `requireDMNotBlocked`) | failing-first service/API test | done 2026-08-20 |
| 5 | F-2 | Close the role-reassign/WS-handshake race: handshake paths re-read the user row instead of trusting the auth-time snapshot, and `revokeUnreadableChannels` re-resolves the live client before acting (mirrors `RefreshChannelVisibility`'s OC-0206 hazard notes) | failing-first ws tests + `-tags deadlock` run | done 2026-08-20 |
| 6 | F-6 | Remove the client's inert replay-dedup machinery (`replayDedup`, `isReplaying()`, the two dispatcher gates) — the server sends `auth_ok` before the burst, so the gates can never engage and their no-op behavior is the verified-correct behavior; rewrite the non-representative tests to pin the real frame ordering | client unit suite green | done 2026-08-20 (5036/5036) |
| 7 | — | `ci-check` local CI mirror, push, PR, drive green | CI | pending |

## Decisions taken

- **F-6 resolved by deletion, not repair.** The audit offered
  delete-or-move-the-clear; the adversarial verification established the
  gates' no-op behavior is the correct behavior for unread counts, so making
  them fire would change behavior for the worse. The duplicate-voice-frame
  window on resume (`serve.go` voice supplement) is benign — voice_state
  application is idempotent — and is recorded in the audit, not patched here.
- **F-1 fixed at the mutation site, not the sweep.** Immediate eviction on
  block matches `CloseDM`'s existing semantics and avoids adding a per-minute
  DM/block query to the sweep for every voice state.
- **F-4 is log-only by design** — the audit's verifier established the cap
  self-heals and persistent failures already abort the login; visibility is
  the whole gap.
