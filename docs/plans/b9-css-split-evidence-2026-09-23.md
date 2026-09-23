# B9-1 CSS source split — evidence

**Measured:** 2026-09-23
**Base commit:** `c80c809401ce264eda56b83003536be775ccfa5e` (`origin/dev`, after PR #1726)
**Branch:** `fm/b9-1-impl`
**Plan:** `.claude/plans/b9-1-css-source-split.plan.md` (B9-1)
**PRD:** [b9-unified-experience-accessibility-polish.prd.md](b9-unified-experience-accessibility-polish.prd.md)
**Requirements:** BPR-090, BPR-091

B9-1 moves `Client/src/styles/app.css` into ordered fragments without changing
a rule. Every result below was produced in this session by the command next to
it. A row marked not run or pending was not run.

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

The plan asks for desktop screenshots and computed-style samples for the six
accessibility checks, before and after. They were captured with Playwright
(1.63.0, bundled Chromium, headless) against the **built** app, not the dev
server:

1. Build `vite build --config vite.config.desktop.ts` twice: once at this
   branch, once with `Client/src/styles` checked out at `c80c8094` (the only
   `Client/src` difference between the two commits). `diff -r` on the two
   `dist/` trees: **identical**, all 27 assets.
2. Serve each tree with `vite preview --outDir <dist> --strictPort` on its own
   free port.
3. Run the capture spec below against each, with the mocked Tauri session
   from `Client/tests/e2e/helpers.ts`. Every state records a PNG and a JSON
   sample: computed `color`, `background-color`, `outline-*`, `box-shadow`,
   `font-size`, `line-height`, `transition-duration`, `animation-*`, `opacity`,
   `display` and size for 18 shell, dialog and control selectors plus the
   focused element; the viewport and scroll sizes; the root/body classes; and
   Playwright's ARIA snapshot of `body`.

| Check           | States captured (1280×800 unless noted)                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyboard, focus | In dark, neon-glow, midnight and light: shell; Tab from the document start; Ctrl+K quick switcher with an active option; Settings → Appearance with arrow-key focus on the tab list; member-picker modal after Tab. |
| Contrast        | The same four themes, plus High Contrast on dark with a custom `#ffff00` accent (the Q8 fallback case).                                                                                                             |
| Reduced motion  | OS `reduce` with the app setting off; OS `no-preference` with the app setting on.                                                                                                                                   |
| Zoom/reflow     | 940×500 at text size 12 px; 940×500 at 20 px with Large Font; 940×500 at device scale 2 (200 %) and 20 px.                                                                                                          |
| Screen reader   | ARIA snapshot of every state above (a structural proxy only; see the table below).                                                                                                                                  |

**Result.** 26 states, before and after:

- **Computed-style and ARIA samples:** 26 of 26 byte-identical (the
  concatenated JSON hashes to `de695e3a…` on both sides).
- **Screenshots:** 23 of 26 byte-identical. The other three
  (`dark-05-modal-focus`, `midnight-05-modal-focus`,
  `neon-glow-03-quick-switcher`) differ in 4 to 28 pixels, by at most 5/255
  per channel. This is run-to-run rendering noise, not a CSS difference. A
  second capture of the _before_ build differed from the first in the same
  kinds of states (`neon-glow-03-quick-switcher`, `neon-glow-05-modal-focus`),
  and the two builds are byte-identical.

The PNGs (3.5 MB a side) are not committed. The spec regenerates them from any
two builds.

| Check                                   | Status                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Desktop screenshots, before/after       | **Run** in headless Chromium, with the result above. No native WebView2/WebKitGTK window on this host.                    |
| Keyboard, focus, contrast, motion, zoom | **Run** as computed-style samples, with the result above. Native OS zoom and OS motion settings: not run.                 |
| NVDA / Orca                             | **Owner-run, pending.** Q1 names the repository owner as the accessibility reviewer; an agent cannot run a screen reader. |

<details>
<summary>Capture spec and config: save as <code>Client/test-results/b9-evidence/pw.config.ts</code> and <code>capture.spec.ts</code> (gitignored), run from <code>Client/</code></summary>

```sh
B9_URL=http://127.0.0.1:<port> B9_OUT=<dir> npx playwright test -c test-results/b9-evidence/pw.config.ts
```

```ts
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  outputDir: "./pw-out",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], baseURL: process.env.B9_URL },
});
```

```ts
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../../tests/e2e/fixtures";
import {
  mockTauriFullSessionWithMessages,
  navigateToMainPageReady,
  openSettings,
  switchSettingsTab,
} from "../../tests/e2e/helpers";

const OUT = process.env.B9_OUT!;
mkdirSync(OUT, { recursive: true });

const PROPS = [
  "color",
  "background-color",
  "border-top-color",
  "outline-style",
  "outline-width",
  "outline-color",
  "outline-offset",
  "box-shadow",
  "font-size",
  "line-height",
  "transition-duration",
  "animation-name",
  "animation-duration",
  "opacity",
  "display",
  "width",
  "height",
];
const SELECTORS = [
  "body",
  ".sidebar",
  ".channel-item",
  ".channel-item.active",
  ".message",
  ".msg-text",
  ".chat-header",
  ".message-input",
  ".member-list",
  ".user-bar",
  ".settings-panel",
  ".settings-nav-item",
  '.settings-nav-item[aria-selected="true"]',
  ".quick-switcher",
  ".quick-switcher__input",
  '.quick-switcher__item[aria-selected="true"]',
  ".dm-member-picker-modal",
  ".toast-container",
];

async function record(page: Page, name: string): Promise<void> {
  const sample = await page.evaluate(
    ({ selectors, props }) => {
      const pick = (el: Element | null) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
      };
      const active = document.activeElement;
      return {
        viewport: {
          w: innerWidth,
          h: innerHeight,
          scrollW: document.documentElement.scrollWidth,
          scrollH: document.documentElement.scrollHeight,
        },
        htmlClass: document.documentElement.className,
        bodyClass: document.body.className,
        focused: active
          ? {
              tag: active.tagName,
              cls: active.className,
              label: active.getAttribute("aria-label"),
              style: pick(active),
            }
          : null,
        styles: Object.fromEntries(selectors.map((s) => [s, pick(document.querySelector(s))])),
      };
    },
    { selectors: SELECTORS, props: PROPS },
  );
  const aria = await page.locator("body").ariaSnapshot();
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify({ ...sample, aria }, null, 2));
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: "disabled", caret: "hide" });
}

async function boot(page: Page, prefs: Record<string, unknown>, theme: string): Promise<void> {
  await page.addInitScript(
    ({ p, t }) => {
      localStorage.setItem("owncord:theme:active", t);
      for (const [k, v] of Object.entries(p))
        localStorage.setItem(`owncord:settings:${k}`, JSON.stringify(v));
    },
    { p: prefs, t: theme },
  );
  await mockTauriFullSessionWithMessages(page);
  await page.goto("/");
  await navigateToMainPageReady(page);
}

test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

for (const theme of ["dark", "neon-glow", "midnight", "light"]) {
  test(`shell, focus, dialogs — ${theme}`, async ({ page }) => {
    await boot(page, {}, theme);
    await record(page, `${theme}-01-shell`);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
    await record(page, `${theme}-02-keyboard-focus`);
    await page.keyboard.press("Control+k");
    await page.locator(".quick-switcher__input").fill("gen");
    await expect(page.locator('.quick-switcher__item[aria-selected="true"]').first()).toBeVisible();
    await record(page, `${theme}-03-quick-switcher`);
    await page.keyboard.press("Escape");
    await openSettings(page);
    await switchSettingsTab(page, "Appearance");
    await page.locator('.settings-nav-item[aria-selected="true"]').focus();
    await page.keyboard.press("ArrowDown");
    await record(page, `${theme}-04-settings-focus`);
    await page.keyboard.press("Escape");
    await page.locator(".sidebar-dm-section .category-add-btn").click();
    await expect(page.locator(".dm-member-picker-modal")).toBeVisible();
    await page.keyboard.press("Tab");
    await record(page, `${theme}-05-modal-focus`);
  });
}

test("contrast — high-contrast and custom accent", async ({ page }) => {
  await boot(page, { highContrast: true, accentColor: "#ffff00" }, "dark");
  await record(page, "contrast-01-high-contrast-custom-accent");
});

for (const motion of ["reduce", "no-preference"] as const) {
  test(`motion — OS ${motion}, app reducedMotion on/off`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await boot(page, { reducedMotion: motion === "no-preference" }, "neon-glow");
    await record(page, `motion-${motion}`);
  });
}

for (const [label, prefs] of [
  ["font12", { fontSize: 12 }],
  ["font20-large", { fontSize: 20, largeFont: true }],
] as const) {
  test(`zoom/reflow — 940x500 ${label}`, async ({ page }) => {
    await page.setViewportSize({ width: 940, height: 500 });
    await boot(page, prefs, "neon-glow");
    await record(page, `reflow-940x500-${label}`);
  });
}

test.describe("zoom 200%", () => {
  test.use({ viewport: { width: 940, height: 500 }, deviceScaleFactor: 2 });
  test("zoom/reflow — 1880x1000 physical at 200%", async ({ page }) => {
    await boot(page, { fontSize: 20 }, "neon-glow");
    await record(page, "reflow-200pct-font20");
  });
});
```

</details>

## Rollback

Revert this PR. The manifest and fragments go together; `main.ts` is untouched.
