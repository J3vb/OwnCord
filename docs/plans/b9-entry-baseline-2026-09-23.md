# B9 entry baseline

**Measured:** 2026-09-23
**Base commit:** `f32149c47756b06f2400d484b3347fd782586ff3` (`origin/dev`, after PR #1724)
**Branch:** `fm/b9-0-impl`
**Plan:** `.claude/plans/b9-0-entry-evidence-and-decisions.plan.md` (B9-0)
**PRD:** [b9-unified-experience-accessibility-polish.prd.md](b9-unified-experience-accessibility-polish.prd.md)
**Requirements:** BPR-064, BPR-090..092; client halves of BPR-060..063 and BPR-070..073

B9-0 changes no product code, tests or CI. It re-reads the planning inventory
at the real base, records the entry-gate verdicts, the measured baselines that
B9-1..B9-3 ratchet against, and the register reconciliation. Every number
below was produced in this session by the command next to it, on the base
commit above. A row marked **NOT RUN** was not run; nothing here is a claim of
native, assistive-technology or platform acceptance.

## Environment

| Tool                | Version                                 | Note                                                                                                  |
| ------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Host                | Ubuntu 24.04.5 LTS, Linux 6.8.0, x86_64 | Headless agent host: no display, no desktop session, no screen reader. Not the named desktop machine. |
| Node / npm          | 26.9.0 / 11.19.1                        | `nvm use 26`; matches `Client/.nvmrc`.                                                                |
| Vitest / Playwright | 4.1.11 / 1.63.0                         | Chromium headless shell downloaded into a session scratch directory, not the shared browser cache.    |
| Go / rustc          | 1.26.7 / 1.98.1                         | Recorded only; no Go or Rust gate is affected by a documentation-only PR.                             |

## Base and drift since the planning commit

The PRD and every milestone plan were read at `0beee8e4c50ca18823750e381d3a1d6e327029b8`.
The real base is 15 commits later. Command: `git log --oneline 0beee8e4..f32149c4`
and, for each backticked file the PRD and the B9-0 plan cite,
`git diff --quiet 0beee8e4 f32149c4 -- <path>`.

| Item                              | At planning commit                                                                   | At the real base                                                                                                                                                                                                       | Consequence                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| B9-0 inventory rows 1–4           | `Server/updater/assets.go:32-43`, broker contract/desktop, a11y smoke, B5/HP-5 lines | Unchanged byte for byte. `clientAssetSuffixByTarget` still maps only `windows-x86_64-nsis`, `linux-x86_64-appimage` and `linux-aarch64-appimage`.                                                                      | Inventory holds.                                                                             |
| Other product files the PRD cites | 48 distinct paths                                                                    | None changed. The intervening product commits touch Linux native voice, presence and screen share, which no B9 plan cites.                                                                                             | Line citations hold.                                                                         |
| `Client/CLAUDE.md`                | "no local `tauri build`" at `:125`                                                   | Same rule at `Client/CLAUDE.md:136` (native-voice paragraph grew). Dispatcher rule `:46` and contract-test rule `:23` unchanged.                                                                                       | Read the PRD's `Client/CLAUDE.md:125` as `:136`.                                             |
| Issue register line numbers       | `:123`, `:176`, `:193`, `:210-216`, `:302-313`                                       | Every row moved down five lines (a dated ledger-truth paragraph was added at `:85-88`): `:128`, `:181`, `:198`, `:215-221`, `:307-318`.                                                                                | Read PRD register citations with +5.                                                         |
| Ledger open entries               | Four open: OC-0445..OC-0448 at `:10331-10390`                                        | **445 fixed / 1 open / 4 declined / 1 duplicate = 451.** OC-0446/0447 (#1709) and OC-0448 (#1708) fixed; OC-0449..0451 recorded and fixed. OC-0445 is the only open entry (`.superpowers/findings-ledger.json:10331`). | None of these is a B9 finding. The PRD's disposition paragraph is annotated with this drift. |
| The 24 B9-tagged ledger records   | 24 fixed at `:7399`..`:8807`                                                         | Unchanged: the ledger diff touches only lines 1–5 and 10352 onward.                                                                                                                                                    | Disposition table holds.                                                                     |
| Branch name                       | Plan names `docs/b9-0-entry-evidence-and-decisions`                                  | Implemented on `fm/b9-0-impl` (task branch assigned by the dispatcher).                                                                                                                                                | Name only; still one PR into `dev`.                                                          |

## Entry-gate verdicts at this head

Roadmap gate: `docs/plans/repo-health-roadmap-2026-08-23.md:1175-1181`.

| Entry item                                                | Verdict                                      | Evidence at `f32149c4`                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop platform matrix green (B7-17 and HP-7)            | **NOT MET**                                  | B7-17 has no step plan in the B7 PRD milestone table and no recorded result; HP-7 is unsigned (no `hp-7-scorecard-*.md` in `docs/plans/`). The updater still has no Windows ARM64 client target (`Server/updater/assets.go:39-43`). A server ARM64 job is not client evidence. |
| B5 contracts stable and security-reviewed                 | **NOT MET as a complete B9 gate**            | README still records B5 IN PROGRESS with the moderation-evidence-consent follow-up open; the follow-up text is unchanged (`docs/plans/b5-community-content-moderation-2026-09-04.md:2940-2956`). No acceptance record exists for it.                                           |
| Tokens, interaction patterns and accessibility test rules | **Decided; baseline recorded here; NOT MET** | Q1/Q2/Q4/Q8 decided 2026-09-23. The measured inventory and the rule set are in [Execution contract](#execution-contract-for-b9-1b9-3) below. They become the agreed rules only when the owner records acceptance; this document does not sign for the owner.                   |
| Recipient discovery (Q6) and effective voice UI (Q5)      | **Decided; contracts not implemented**       | No `can_moderate_voice` in `protocol/schema.json`; no `GET /api/v1/users/me/moderation` route in `Server/api/router.go`. Blocks B9-14 and complete B9-15/16 only.                                                                                                              |
| Common per-item entry contract                            | Met for B9-0 only                            | This PR: assigned implementer, real base, drift recorded, documentation-only scope.                                                                                                                                                                                            |
| Q9 foundation-lane amendment                              | **In force**                                 | B9-1, then B9-2, then B9-3 may start after this PR merges. B9-4 onward waits for the three NOT MET rows above and B7-10/B7-11.                                                                                                                                                 |

## Owner decisions

Q1–Q12 were decided by the owner on 2026-09-23 and are recorded, with options
and historical recommendations, in the PRD's
[Open questions](b9-unified-experience-accessibility-polish.prd.md#open-questions)
and in every milestone plan that carries them (PR #1724). B9-0 adds no decision.

| Question | Operative for                           | Scheduled                                                                                      |
| -------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Q1       | Every milestone's accessibility block   | Now. Named reviewer: the repository owner.                                                     |
| Q2       | B9-4, B9-5, B9-11, B9-15                | B9-4 onward, after the gate.                                                                   |
| Q3       | B9-8, B9-9                              | After the gate.                                                                                |
| Q4, Q10  | B9-13, B9-15                            | After the gate.                                                                                |
| Q5, Q6   | Upstream contract PRs, then B9-14/15/16 | Each needs an owner-assigned, owner-approved plan before implementation.                       |
| Q7       | B9-3, B9-18..20                         | B9-3 now (foundation lane).                                                                    |
| Q8       | B9-2                                    | B9-2 now (foundation lane).                                                                    |
| Q9       | Lane order                              | In force now.                                                                                  |
| Q11, Q12 | HP-9                                    | **Recorded again at HP-9 by B9-27**; HP-9's scorecard carries the reader results and cut list. |

## Execution contract for B9-1..B9-3

### Token and theme inventory (measured)

Commands: `grep -oE '^\s*--[a-z0-9-]+\s*:'`, `grep -oE '#[0-9a-fA-F]{3,8}\b'`
and `grep -oE 'rgba?\('`, counted per file under `Client/src/styles/`.

| File                  | Lines | Custom-property definitions | Hex literals | `rgb()`/`rgba()` |
| --------------------- | ----: | --------------------------: | -----------: | ---------------: |
| `tokens.css`          |   118 |                          72 |           35 |                7 |
| `base.css`            |   116 |                           0 |            1 |                0 |
| `login.css`           |  1469 |                           0 |           15 |               29 |
| `app.css`             |  5455 |                           3 |           55 |               65 |
| `theme-neon-glow.css` |    34 |                          19 |           12 |                3 |

- Import order: tokens, base, login, app, theme-neon-glow (`Client/src/main.ts:3-7`).
- Built-in themes: dark, neon-glow (default), midnight, light
  (`Client/src/lib/themes.ts:11`); High Contrast is a class (`Client/src/styles/app.css:4851`);
  ten accent presets (`Client/src/components/settings/AppearanceTab.ts:125`).
  These are the Q8 qualification set.
- Reduced motion: two `prefers-reduced-motion` blocks in `app.css`, one in
  `login.css`, and the in-app `.reduced-motion` class (`app.css:4839`).
- Minimum window 940×500 (`Client/src-tauri/tauri.conf.json:17-18`), the Q1 reflow floor.

The 165 colour literals in `app.css`, `login.css` and `base.css` are the C-13
remainder B9-2 owns; B9-1 moves them without changing them.

### Interaction and accessibility rules

The rule set every B9 PR applies is the PRD's accessibility block at the Q1
thresholds, reusing the existing primitives rather than new global state:

| Rule                | Threshold or pattern                                                                                          | Existing primitive                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Dialogs             | Labelled, focus contained, Escape closes, focus restored to the opener or a safe fallback                     | `Client/src/lib/modalFactory.ts:71-99`                               |
| Focus               | Visible and unobscured (WCAG 2.4.7, 2.4.11); indicator at 3:1                                                 | `Client/src/styles/base.css:34-50`                                   |
| Lists and toolbars  | Roving tabindex with arrow keys                                                                               | `Client/src/lib/a11y.ts:95-160`                                      |
| Contrast            | Text 4.5:1; large text, UI components and focus 3:1; Q8 accent fallback below 3:1                             | tokens above                                                         |
| Targets and spacing | Pointer targets ≥ 24×24 CSS px (2.5.8); text spacing (1.4.12)                                                 | —                                                                    |
| Scale and reflow    | App text 12–20 px with Large Font, OS zoom 200 %, 940×500 window, no lost content or function                 | `Client/src/lib/appearance.ts:14-56`                                 |
| Motion              | Honour both the OS setting and the in-app toggle; no motion-only feedback                                     | `.reduced-motion`, `prefers-reduced-motion`                          |
| Announcements       | Status announced once through the existing polite live regions                                                | toast and typing regions (`Client/tests/e2e/a11y-smoke.spec.ts:101`) |
| Native evidence     | One NVDA (Windows 11) and one Orca (Linux) recording per milestone journey; automated reports supplement only | —                                                                    |

### File ownership (single-writer lane)

| Shared surface                                                                         | Writer, in order        |
| -------------------------------------------------------------------------------------- | ----------------------- |
| `Client/src/styles/app.css` split and CSS import order in `main.ts`                    | B9-1 only               |
| `tokens.css`, shared focus/dialog/roving primitives                                    | B9-2, after B9-1 merges |
| English catalog API and formatting seam                                                | B9-3, after B9-2 merges |
| MainPage/navigation composition, dispatcher registration, stores, `api.ts`, `types.ts` | B9-4 onward, gated      |

Each lane PR rebases on current `dev` after the previous one merges and re-runs
its checks there (Q9 residual risk 2).

## Measured baselines

| Measure                                  | Command (from `Client/` unless noted)                                | Result at `f32149c4`                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broker unit contract                     | `npx vitest run tests/unit/platform/externalContent.desktop.test.ts` | **15/15 passed**                                                                                                                                                                                                                                                                                   |
| Accessibility smoke (mocked Tauri)       | `CI=1 npx playwright test tests/e2e/a11y-smoke.spec.ts`              | **5/5 passed**: settings dialog/tablist/Escape restore, quick switcher combobox, factory-modal Tab trap, live regions, first-use trust modal. Structural only.                                                                                                                                     |
| Bundle budgets                           | `npm run build:budget && npm run check:budgets`                      | All ok: startup closure 86 085 B / 91 000 B (7 files), MainPage 57 140 / 60 000, livekit 133 409 / 135 000, livekitSession 22 464 / 24 000.                                                                                                                                                        |
| Emitted CSS (B9-1 equality oracle)       | `npm run build:budget`, then `sha256sum dist-budget/assets/*.css`    | One file, `style-w1RbVdF1.css`, 105 090 bytes (18.72 kB gzip), sha256 `788f21f90f5dc7454df2de53e4bda3c2ac49e834d3d1cd21909f4e2d91ebac32`. Identical on a second build.                                                                                                                             |
| Docs and hygiene gates (repository root) | `npm run check:docs`, `npm run check:hygiene`                        | `check:docs` passed at the base and on this branch. `check:hygiene` steps passed on this branch; Prettier was run over tracked files (a gitignored local tooling directory fails `prettier --check .` on this host only) and shellcheck is not installed here (CI runs it; no shell file changed). |
| Startup and memory                       | Accepted B7 evidence                                                 | 598 ms to the connect form, 380 MB WebView RSS, Windows 11 desktop, `tauri dev` ([B7-0 baseline](b7-0-client-baseline-2026-09-19.md#startup-and-memory)). Reused, not re-measured.                                                                                                                 |
| Interaction latency and sidebar rebuild  | —                                                                    | **NOT MEASURED.** No accepted baseline exists; B9-21 measures before/after on one machine and fixture. No target is set here.                                                                                                                                                                      |
| NVDA / Orca versions and recordings      | —                                                                    | **NOT RUN.** This host has no desktop session or screen reader. The owner records versions with the first recording.                                                                                                                                                                               |
| Theme screenshots                        | —                                                                    | **NOT RUN.** A mocked headless browser is not the desktop WebView; B9-1 Task 1 saves desktop screenshots at its start SHA; B9-2 adds the reusable screenshot fixture.                                                                                                                              |

The CSS hash is a starting point, not B9-1's proof: B9-1 recomputes it at its
own merge base (Q9 residual risk 2) and compares ordered rules if a bundler
difference makes bytes unequal.

## B9-0 journey manifest

Journey: connect, open Settings, switch a server, navigate a channel and review
the current consent prompt without changing state.

| Step                      | Automated coverage today                             | Native keyboard / NVDA / Orca / contrast / motion / reflow |
| ------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| Connect and trust         | a11y smoke: first-use trust modal                    | NOT RUN                                                    |
| Open Settings             | a11y smoke: labelled dialog, tablist, Escape restore | NOT RUN                                                    |
| Switch a server           | a11y smoke: quick switcher combobox/listbox          | NOT RUN                                                    |
| Navigate a channel        | none in the smoke                                    | NOT RUN                                                    |
| Review the consent prompt | none; the NSFW gate still uses session state (B9-7)  | NOT RUN                                                    |

## Requirement evidence matrix

No row is qualified by B9-0. Each keeps its status until its milestones supply
exact-SHA evidence.

| Requirement | Evidence milestones    | Status at this head |
| ----------- | ---------------------- | ------------------- |
| BPR-060     | 5, 6, 26               | Not qualified       |
| BPR-061     | 8, 9, 19, 26           | Not qualified       |
| BPR-062     | 8, 9, 26               | Not qualified       |
| BPR-063     | 7, 11, 26              | Not qualified       |
| BPR-064     | 3, 18, 19, 20, 26      | Not qualified       |
| BPR-070     | 10, 26                 | Not qualified       |
| BPR-071     | 11, 12, 13, 14, 17, 26 | Not qualified       |
| BPR-072     | 13, 14, 15, 26         | Not qualified       |
| BPR-073     | 15, 16, 17, 26         | Not qualified       |
| BPR-090     | 1, 2, 4, 21..26        | Not qualified       |
| BPR-091     | Every milestone        | Not qualified       |
| BPR-092     | 9, 24, 25, 26          | Not qualified       |

## Register reconciliation

All 24 B9-tagged `OC-*` rows are `fixed` in the ledger (command: read each id's
`status` from `.superpowers/findings-ledger.json`). Sixteen register rows
already said so. The other eight carried only their original closure text, so
this PR appends the ledger's fix to each, without changing any status:

| Record  | Fixed by           | Source still present at `f32149c4`                                                |
| ------- | ------------------ | --------------------------------------------------------------------------------- |
| OC-0319 | #1532 (`39b2423f`) | `Client/tests/unit/appearance-large-font.test.ts`                                 |
| OC-0342 | #1530 (`1edd777f`) | per ledger                                                                        |
| OC-0356 | #1530 (`1edd777f`) | `.quick-switch-*` rules at `Client/src/styles/app.css:4866-4920`                  |
| OC-0368 | #1530 (`1edd777f`) | `Client/src/components/UserProfilePopup.ts` uses the shared focus trap            |
| OC-0370 | #1530 (`1edd777f`) | `scrollIntoView` at `Client/src/components/inline-autocomplete.ts:158`            |
| OC-0371 | #1530 (`1edd777f`) | `.btn-modal-cancel` at `Client/src/styles/login.css:1035`                         |
| OC-0372 | #1530 (`1edd777f`) | `max-height: 85vh` at `Client/src/styles/app.css:4878`, scrolling list at `:4901` |
| OC-0375 | #1532 (`39b2423f`) | `Client/tests/unit/main-page.test.ts:604`                                         |

B9 adds regression acceptance for these in its milestones; it does not reopen
or re-fix them. OC-0445, the one open ledger entry, is an operational delivery
budget, not a B9 UI finding. Upstream release blockers — B7-17/HP-7, the missing
Windows ARM64 updater target, the B5 moderation-evidence consent follow-up and
the rehearsed tag/HP-6 — are recorded above without changing their status.
