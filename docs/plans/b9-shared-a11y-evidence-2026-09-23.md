# B9-2 shared accessibility and tokens — evidence

**Measured:** 2026-09-23
**Base commit:** `3c55f811f1fe225bb0c54b5c213da8e5dcee6d3b` (`dev`, after B9-1's PR #1731), with `dev` `c94f0198` merged in before validation (it touches no file in this change)
**Branch:** `fm/b9-2-impl`
**Plan:** `.claude/plans/b9-2-shared-accessibility-and-tokens.plan.md` (B9-2)
**PRD:** [b9-unified-experience-accessibility-polish.prd.md](b9-unified-experience-accessibility-polish.prd.md), owner decisions Q1 and Q8, and the 2026-09-23 Q8 clarification
**Contract:** [docs/architecture/b9-ui-contract.md](../architecture/b9-ui-contract.md)
**Requirements:** BPR-090, BPR-091

Every result below came from the command next to it, run during this session.
A row marked pending was not run.

## Environment

| Tool       | Version                                 | Note                                                                         |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| Host       | Ubuntu 24.04.5 LTS, Linux 6.8.0, x86_64 | Headless agent host: no display, desktop session or screen reader.           |
| Node       | 26.9.0                                  | `nvm use 26`                                                                 |
| Playwright | 1.63.0, bundled Chromium (build 1243)   | Mocked Tauri (`tests/e2e/helpers.ts`), 1280×720 unless the test sets a size. |

## Inventory at the real base

`git diff 0beee8e4 3c55f811` over the plan inventory's files: no change. The
three inventory rows hold. What the measurement found at the base, beyond that
inventory, is in the plan's "Drift at the implementation base" section and in
the before column below.

## Failing control, then the fix

The new spec `Client/tests/e2e/b9-primitives.spec.ts` (22 tests) was run twice.
The first run used the unmodified base: a detached worktree at `3c55f811`
with only the spec, its helper and `src/lib/color-contrast.ts` copied in. The
second run used this branch. Command, from `Client/`:
`npx playwright test tests/e2e/b9-primitives.spec.ts --workers=4`.

| Check                                                                                                                                         | Base `3c55f811`                                                                                                                                                                                                                                                 | This branch |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Token matrix, dark / neon-glow / midnight / light                                                                                             | **Fail**: 270 / 111 / 231 / 693 failing pairs. Examples: light `--text-link` 2.08–2.62:1, neon-glow white on its cyan accent 1.45:1 (and 1.96:1 on buttons), dark `--text-danger` 3.35:1 and `--text-positive` 3.97:1, no `--accent-text`/`--focus-ring` at all | Pass        |
| Shared-controls fixture, 4 themes × High Contrast                                                                                             | **Fail** in all 8 states. Danger button 3.77:1; placeholder 2.27–3.02:1; dark focus ring 2.74:1; the switch and link got only the 1px UA ring (1.10–1.51:1); light modal heading 1.00:1 (white on white); light + High Contrast body text 1.61:1                | Pass        |
| Keyboard journey at 20px Large Font, 940×500                                                                                                  | **Fail**: OS reduced motion not applied                                                                                                                                                                                                                         | Pass        |
| OS reduce with no app setting                                                                                                                 | **Fail**: no `reduced-motion` class, modal animates                                                                                                                                                                                                             | Pass        |
| Other 8 tests (real modal, app toggle, motion control, sync off, reflow ×3, negative controls)                                                | Pass                                                                                                                                                                                                                                                            | Pass        |
| Same spec, production bundle (`npm run build`, then `npx playwright test --config playwright.config.prod.ts tests/e2e/b9-primitives.spec.ts`) | not run                                                                                                                                                                                                                                                         | 22 passed   |

## Contrast matrix (Q1 thresholds, Q8 accent policy)

For each theme, the spec stored the preferences and reloaded, so the app's own
startup path applied them. It ran 26 states per theme: High Contrast off and on, each
with the theme's own accent, the ten presets, and two custom accents chosen
to trip the fallback (`#2b2d31`, `#ffff00`). In every state it measured each
token against all four surfaces (`--bg-primary`, `--bg-secondary`,
`--bg-tertiary`, `--bg-input`). The full per-state JSON (`token-matrix-*.json`)
and the fixture screenshots are attached to the Playwright report, which CI
uploads as `playwright-report`.

Lowest ratio per token across all 26 states (High Contrast only raises these):

| Token (threshold)                        | dark  | neon-glow | midnight | light |
| ---------------------------------------- | ----- | --------- | -------- | ----- |
| `--text-normal` (4.5)                    | 8.42  | 11.20     | 8.61     | 10.02 |
| `--text-muted` (4.5)                     | 4.63  | 6.17      | 4.63     | 5.12  |
| `--header-primary` (4.5)                 | 10.24 | 13.63     | 10.24    | 16.05 |
| `--header-secondary` (4.5)               | 5.82  | 7.75      | 5.82     | 6.37  |
| `--text-link` (4.5)                      | 4.64  | 4.85      | 4.64     | 4.67  |
| `--accent-text` (4.5)                    | 4.52  | 4.85      | 4.52     | 5.09  |
| `--text-positive` (4.5)                  | 4.60  | 6.13      | 4.60     | 4.67  |
| `--text-warning` (4.5)                   | 6.02  | 8.01      | 6.02     | 4.73  |
| `--text-danger` (4.5)                    | 4.66  | 6.20      | 4.66     | 4.65  |
| `--focus-ring` (3)                       | 3.18  | 3.28      | 3.18     | 3.04  |
| `--on-accent` on fill/hover/active (4.5) | 4.61  | 4.61      | 4.61     | 4.61  |
| `--text-faint` (not qualified)           | 3.04  | 4.04      | 3.04     | 3.22  |
| `--text-micro` (not qualified)           | 2.27  | 3.02      | 2.27     | 2.22  |

In each theme, the spec also asserts the Q8 fallback in every accent state:
`--accent-text` is the accent only at 4.5:1 or better and `--focus-ring` only
at 3:1 or better, both measured as the minimum over the four surfaces.
Otherwise each is the theme's tested colour, and under High Contrast always the
tested colour. The accent was replaced for text in 7 of the 12 non-default
states (dark, midnight), 4 (neon-glow) and 11 (light). It was replaced as the
focus ring in 3, 1 and 9 respectively.

`Client/tests/unit/color-contrast.test.ts` checks every 12-bit colour as an
accent. The derived `--on-accent` reads at 4.5:1 or better on the fill, the
hover and the active shade for all of them.

## Shared-controls fixture

`mountSharedControls` renders the real classes over the running app: modal,
header, labelled field with `.form-error` and `.form-status`, a named switch,
a link, and the cancel, danger and save buttons. Each theme was run with High
Contrast off and on. Every visible control has an accessible name, and every
button, input and switch is at least 24×24px. Tab from the dialog reaches
all 7 controls, each with a 2px `--focus-ring` outline at 3:1 or better. All
text passes 4.5:1 in the normal, hover, error and success states, including
the placeholder, the field value, and the error and success messages. The
switch track passes 3:1 against the dialog, both off and on.
Lowest values: switch track 3.18:1 (light, on) and 3.38:1 (dark, off); on-accent
and danger buttons 4.61:1 and 4.76:1. Per-state JSON and PNGs:
`fixture-<theme>[-hc].{json,png}` in the report.

## Keyboard, focus, motion and reflow

| Check               | Result                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keyboard journey    | At 940×500, 20px with Large Font, OS reduced motion. Keyboard only: an empty submit announces "Saving…" (`role="status"`, `aria-busy`), then "Enter a channel name." (`role="alert"`, linked by `aria-describedby`, `aria-invalid`), and focus stays on the field. The switch toggles with Space. A submit from the Save button succeeds, and focus stays on Save. |
| Real dialog         | The DM member-picker (`createModal`): Tab and Shift+Tab stay inside with a passing focus ring, and Escape returns focus to the "+" opener with a passing ring.                                                                                                                                                                                                     |
| Reduced motion      | OS `reduce` with no app setting: reduced, modal `animation-duration` 0s. OS `no-preference` with the app toggle on: reduced. Neither: the modal animates for 0.3s (the control). OS `reduce` with Sync with OS turned off and the toggle off: not reduced (the user opt-out).                                                                                      |
| Reflow              | 940×500 at 12px; at 20px with Large Font; and at 20px with device scale 2 (OS zoom 200 % keeps the 940×500 logical window). Every fixture control scrolls into view unclipped, and there is no horizontal page scroll.                                                                                                                                             |
| Negative controls   | An unnamed button is reported (`- button`). Removing the Save button's focus ring is reported (`no outline`). Text at `#5a5c63` on the dialog is reported below 4.5:1. Each check passes again once the fault is removed.                                                                                                                                          |
| Existing a11y tests | `tests/e2e/a11y-smoke.spec.ts`, `tests/unit/accessibility-tab.test.ts` and the other affected unit suites pass; see the Validation section of the PR.                                                                                                                                                                                                              |

## Validation

Run on this branch after merging `dev` `c94f0198` (Node 26.9.0):

| Gate                                                                | Result                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check:client` (repository root)                            | Passed: Tauri version pair, typecheck, lint (oxlint, cycles, eslint), knip, coverage run (286 files, 6272 passed, 149 expected fail), bundle budgets all ok.                                                                                                      |
| `npm run typecheck:build`, `npm run typecheck:e2e` (from `Client/`) | Clean.                                                                                                                                                                                                                                                            |
| `npm run check:docs`, `npm run check:hygiene`                       | Docs passed. Prettier is clean on every tracked file. The only local hygiene warning is an untracked host-tool file outside the repository's tracked set.                                                                                                         |
| Full mocked Playwright suite (`npx playwright test`)                | 455 passed, 7 skipped, 2 failed. Both failures were `settings-tabs-extra.spec.ts` tests that assumed Sync with OS defaulted to off. Their preconditions now match the Q1 default, and that spec, this spec, `a11y-smoke` and `theme-persistence` pass (49 tests). |

Two unit suites had their preconditions changed because Q1 changes the
intended behaviour: `os-motion.test.ts` (the manual toggle is no longer
overridden by an OS without the preference) and the Sync-with-OS default in
`accessibility-tab.test.ts` and `AccessibilityTab.test.ts`. No assertion was
dropped. Each changed expectation has a test for the new rule, and
`stored-appearance.test.ts` now covers startup following the OS setting.

## Not qualified here

| Item                                                             | Status                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NVDA (Windows 11) and Orca (GNOME) recordings of the journey     | **Owner-run, pending.** Q1 names the repository owner as the reviewer; an agent on this host cannot run a screen reader. The ARIA assertions above are a structural proxy only.                                                                                                                |
| Owner visual acceptance of the token changes                     | **Pending.** Visible changes: text on accent fills in neon-glow (the default theme) and on light presets is now black; neon-glow hover/active are lighter cyan (the gradient keeps its purple stop); `--text-muted` is slightly lighter; the light theme's link and status colours are darker. |
| Feature screens outside the shared primitives                    | Not restyled (plan scope). Hard-coded `white`/`#fff` text on non-accent surfaces, and `--red`/`--green` used as text, remain for B9-21..B9-24. So do the ~78 uses of `--text-faint`/`--text-micro`.                                                                                            |
| Native WebView2 / WebKitGTK rendering, native OS zoom and motion | Not run. The checks above run in headless Chromium.                                                                                                                                                                                                                                            |
