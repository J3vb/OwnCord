# B9-1 CSS source split — evidence

**Measured:** 2026-09-23
**Base commit:** `c80c809401ce264eda56b83003536be775ccfa5e` (`origin/dev`, after PR #1726)
**Branch:** `fm/b9-1-impl`
**Plan:** `.claude/plans/b9-1-css-source-split.plan.md` (B9-1)
**PRD:** [b9-unified-experience-accessibility-polish.prd.md](b9-unified-experience-accessibility-polish.prd.md)
**Requirements:** BPR-090, BPR-091

B9-1 moves `Client/src/styles/app.css` into ordered fragments without changing
a rule. Every result below was produced in this session by the command next to
it. A row marked **NOT RUN** was not run.

## Environment

| Tool            | Version                                 | Note                                                        |
| --------------- | --------------------------------------- | ----------------------------------------------------------- |
| Host            | Ubuntu 24.04.5 LTS, Linux 6.8.0, x86_64 | Headless agent host: no display, desktop session or reader. |
| Node            | 26.9.0                                  | `nvm use 26`; matches `Client/.nvmrc`.                      |
| Vite / Rolldown | 8.3.0 / 1.2.9                           | Locked by `Client/package-lock.json`.                       |
| Lightning CSS   | 1.33.0                                  | The CSS minifier in the build; locked by the same lockfile. |
| Build config    | `Client/vite.config.desktop.ts`         | `cssCodeSplit: false`, so all CSS is emitted as one file.   |

## Inventory at the real base

`git diff --quiet 0beee8e4 c80c8094 -- Client/src/styles Client/src/main.ts`
plus the supplement and the three named tests: **unchanged** across the 16
intervening commits. The plan's inventory holds:

| #   | Plan row                                  | At `c80c8094`                                                                                                                                                                                                       |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `main.ts:3-7` import order                | Unchanged: tokens, base, login, app, theme-neon-glow. This PR does not touch `main.ts`.                                                                                                                             |
| 2   | app.css sections, `tokens.css:1-29`       | Holds. The plan's `:4875-4905` lies inside the Quick-Switch section, which spans `:4865-4980` (plus the Ctrl+K switcher to `:5024`); NSFW gate at `:5073-5121` as cited. `tokens.css` and `base.css` stay separate. |
| 3   | Supplement `:381-407` preservation clause | Unchanged.                                                                                                                                                                                                          |

## What moved

`app.css` is now an import manifest: a header comment and 28 `@import`
lines, in the original order. Each fragment under `Client/src/styles/app/` is
one contiguous run of the old file, split only at top-level section comments
(brace depth 0, checked with an `awk` counter). No selector, declaration,
comment or blank line inside a section changed. The only source text dropped
is the single blank line that separated two sections at each of the 27 cuts,
because Prettier forbids a trailing blank line in a file.

| Fragment            | Old lines | Fragment                 | Old lines |
| ------------------- | --------- | ------------------------ | --------- |
| `shell.css`         | 3–15      | `animations.css`         | 4123–4231 |
| `sidebar.css`       | 17–443    | `compact-mode.css`       | 4233–4363 |
| `voice-widget.css`  | 445–634   | `pinned-messages.css`    | 4365–4588 |
| `user-bar.css`      | 636–801   | `responsive.css`         | 4590–4604 |
| `chat-area.css`     | 803–1026  | `video.css`              | 4606–4759 |
| `messages.css`      | 1028–2246 | `invite-manager.css`     | 4761–4836 |
| `composer.css`      | 2248–2443 | `accessibility.css`      | 4838–4863 |
| `member-list.css`   | 2445–2648 | `quick-switch.css`       | 4865–5023 |
| `profile-popup.css` | 2650–2823 | `channel-flags.css`      | 5025–5071 |
| `pickers.css`       | 2825–3048 | `nsfw-gate.css`          | 5073–5120 |
| `settings.css`      | 3050–3671 | `profiles-status.css`    | 5122–5199 |
| `overlays.css`      | 3673–3946 | `group-dms.css`          | 5201–5247 |
| `friends-dm.css`    | 3948–4121 | `muted-channels.css`     | 5249–5282 |
|                     |           | `incoming-call.css`      | 5284–5340 |
|                     |           | `dm-profile-sidebar.css` | 5342–5455 |

Sections were not regrouped by domain. Some features appear in more than one
place in the old file (sidebar rules at the top and again in
`channel-flags.css` and `muted-channels.css`; member rows in `member-list.css`
and `profiles-status.css`), and gathering them would reorder rules and could
change which same-specificity declaration wins. That regrouping, if wanted, is
a later behavioural PR with its own review.

## Equality proof

| Check               | Command (from `Client/` unless noted)                                                          | Result                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source identity     | Fragments joined in manifest order with one blank line between, `cmp` against old lines 3–5455 | **Identical.** Old line 1 (the header comment) is kept in the manifest.                                                                                             |
| Emitted CSS, before | `npm run build:budget`, then `sha256sum dist-budget/assets/*.css` at `c80c8094`                | `style-w1RbVdF1.css`, 105 090 bytes, sha256 `788f21f90f5dc7454df2de53e4bda3c2ac49e834d3d1cd21909f4e2d91ebac32` — the same as the B9-0 baseline at `f32149c4`.       |
| Emitted CSS, after  | Same command on this branch                                                                    | `style-w1RbVdF1.css`, 105 090 bytes, sha256 `788f21f90f5dc7454df2de53e4bda3c2ac49e834d3d1cd21909f4e2d91ebac32`. **Byte-identical**, so no AST comparison is needed. |

Vite inlines each relative `@import` before minifying, so the shipped
stylesheet is the same bytes whether the rules live in one file or 28. The
content-hashed filename is unchanged too, which also means nothing that
references the stylesheet changed.

## Tests

Six unit tests pinned CSS rules by reading `src/styles/app.css` as text. They
now read it through `Client/tests/helpers/app-css.ts`, which inlines the
manifest's imports in order; every assertion is unchanged. The failing
control: read raw, the manifest holds no rules (`grep -c quick-switcher
src/styles/app.css` is 0), so without the helper those tests fail.

| Check                          | Command                                                                                                                   | Result                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSS-source unit tests          | `npx vitest run` on the six changed test files                                                                            | 6 files, 23 tests passed.                                                                                                                                        |
| Plan-named e2e plus a11y smoke | `CI=1 npx playwright test tests/e2e/main-layout.spec.ts tests/e2e/theme-persistence.spec.ts tests/e2e/a11y-smoke.spec.ts` | 17 passed. These run against the Vite dev server, so they also exercise the dev-mode `@import` path.                                                             |
| Client gate                    | `npm run check:client` (repository root), then `npm run typecheck:build` and `npm run typecheck:e2e`                      | Passed: Tauri version pair, typecheck, lint, knip, coverage run (285 files; 6242 passed, 149 expected fail), bundle budgets all ok; both extra typechecks clean. |

## Accessibility and visual evidence

Because the emitted stylesheet is byte-identical, the rendered result in any
WebView, theme, accent, scale or motion setting is the same as before this
PR. That is the evidence for all six accessibility checks for this milestone:
nothing they measure can have moved.

| Check                                   | Status                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Desktop screenshots, before/after       | **NOT RUN.** No desktop session on this host (as recorded by B9-0). Byte equality makes them identical. |
| Keyboard, focus, contrast, motion, zoom | **NOT RUN natively.** Structural a11y smoke passed (above). No CSS output changed.                      |
| NVDA / Orca                             | **NOT RUN.** No screen reader on this host; unchanged CSS output cannot change the tree.                |

## Rollback

Revert this PR. The manifest and fragments go together; `main.ts` is untouched.
