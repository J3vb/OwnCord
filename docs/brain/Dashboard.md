# OwnCord — Project Brain

> **Single source of truth for the OwnCord project.**
> Claude Code reads and writes to this vault freely during development sessions.

---

## Quick Links

- [[00-Overview/Project|Project Overview]]
- [[00-Overview/Requirements|Requirements & Specs]]
- [[01-Architecture/Design|Architecture & Design]]
- [[01-Architecture/Tech Stack|Tech Stack]]

## Current Status

**Branch:** `feature/livekit-migration` — LiveKit voice/video integration
**Version:** 1.2.0

### Recent Milestones

- 2026-03-28: Spec audit (18 spec files, 50 fixes), 143 new unit tests, E2E overhaul (22 mocked + 3 native specs), CSS injection security fix, login rate limit 5 -> 60/min
- 2026-03-27: Login redesign (OC neon glow branding, gradient panel, accent stripe cards, animations), app icon, connection quality indicator, remember-password fix, code review (27 fixes)
- 2025-03-24: File reference review completed — 28 doc corrections, all reference docs aligned with code
- 2026-03-21: Code review audit — 30 fixes across server (14) and client (16)
- 2026-03-21: Stabilization complete — all 37 backlog tasks across 7 phases
- 2026-03-20: Camera delay fix, video flicker fix, security hardening
- 2026-03-20: LiveKit migration — voice/video working via LiveKit SFU
- 2026-03-19: Go server code review (4 passes, 19 fixes, APPROVE)
- 2026-03-19: Admin panel redesign + live server logs + audit filters
- 2026-03-18: Voice chat fixed over NAT, 12 tasks completed
- 2026-03-17: CEO plan review completed (HOLD SCOPE)

### In Progress

![[02-Tasks/In Progress]]

### Open Bugs

![[05-Bugs/Open Bugs]]

---

## Recent Activity

### Latest Sessions

```dataview
TABLE date AS "Date", summary AS "Summary"
FROM "03-Sessions"
SORT date DESC
LIMIT 5
```

### Recent Decisions

```dataview
TABLE date AS "Date", status AS "Status"
FROM "04-Decisions"
SORT date DESC
LIMIT 5
```

---

## CEO Plan Review Progress (2026-03-17)

- [x] System Audit
- [x] Step 0: Mode Selection (HOLD SCOPE)
- [x] Section 1: Architecture — 3 issues (1 fix, 1 accept, 1 TODO)
- [x] Section 2: Error & Rescue Map — 9 paths, 4 CRITICAL GAPS fixed
- [x] Section 3: Security & Threat Model — 2 issues (TOFU + IDOR)
- [x] Section 4: Data Flow & Edge Cases — 22 mapped, 2 fixed
- [x] Section 5: Code Quality — 2 issues (both TODO)
- [x] Section 6: Test Review — merge blocked on 80% coverage
- [x] Section 7: Performance — N+1 index fix + TODO
- [x] Section 8: Observability — broadcast logging fix
- [ ] Section 9: Deployment (deferred to post-release)
- [ ] Section 10: Long-Term (deferred to post-release)

---

## Release Readiness (v1.2.0)

- [x] All CRITICAL/HIGH/MEDIUM code review issues fixed
- [x] 0 open bugs
- [x] 0 in-progress tasks
- [x] Admin panel redesigned with live server logs
- [x] Console output cleaned up (text format, banner first)
- [x] 105+ tasks completed across all sessions
- [x] LiveKit migration — voice/video via LiveKit SFU
- [x] Camera button instant feedback + video flicker fix
- [x] Security hardening (key allowlist, cert validation, credential redaction)
- [x] Stabilization backlog — 37 tasks complete (bugs, reliability, protocol, quality, testing, polish)
- [x] Protocol resilience — seq numbers, replay buffer, reconnection state recovery
- [x] Server hardened — panic recovery, heartbeat monitoring, graceful shutdown, typed structs
- [x] Client hardened — disposable pattern, 500-msg cap, shallowEqual store
- [x] Spec audit — 18 spec files updated/created, 50 audit fixes
- [x] 143 new unit tests (Go + TypeScript)
- [x] E2E infrastructure overhaul — persistent fixture, login-once, 22 mocked + 3 native specs
- [x] CSS injection security fix in themes.ts
- [ ] PR feature/livekit-migration -> main created

---

## Feature Roadmap

See [[00-Overview/Feature-Roadmap]] for the full prioritized roadmap.
See [[00-Overview/Competitive-Analysis]] for competitive research.

| Phase | Focus | Tasks | Status |
|-------|-------|-------|--------|
| R1 | Community Essentials | 5 (T-124–T-128) | Backlog |
| R2 | Gaming DNA (Xfire) | 5 (T-129–T-133) | Backlog |
| R3 | Voice Power Features | 4 (T-134–T-137) | Backlog |
| R4 | LAN Party Toolkit | 5 (T-138–T-142) | Backlog |
| R5 | Platform & Extensibility | 6 (T-143–T-148) | Backlog |
| R6 | Future Vision | 5 (T-149–T-153) | Backlog |

All issues created on GitHub with `agent-ready` label.

---

Last updated by Claude Code: 2026-03-28 (Spec audit, 143 unit tests, E2E overhaul, CSS injection fix, new specs: DM-SYSTEM, THEME-SYSTEM, RECONNECTION, E2E-BEST-PRACTICES)
