import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import { fromClientRoot } from "./clientRoot";
import type { ScreenLayoutOption } from "../support/screenLayoutSeed";
import prod from "./playwright.config.prod";

/**
 * Playwright config for the shell specs under Command Deck, against the
 * PRODUCTION build.
 *
 * Usage:  npm run test:e2e:deck
 *
 * It is `playwright.config.prod.ts` with the `screenLayout` option set to
 * "deck", so every page in the listed specs starts on Command Deck through the
 * same fixture seed that pins the other jobs to Classic. The list below names
 * the specs that draw or navigate the app frame (header, sidebars, user bar,
 * voice widget, overlays); a spec that draws nothing the layout changes runs in
 * the parity job only. It is a `testMatch` list rather than a tag so the
 * selection is reviewable in one place and a forgotten tag cannot drop a spec
 * silently.
 *
 * Left out on purpose:
 * - `a11y-scan`: exact counts against `a11y-baseline.json`, which is keyed by
 *   page only. A Command Deck baseline is a follow-up.
 * - `stream-mini-player`, `zoom-reflow`: their Command Deck cases need the dev
 *   server.
 * - the `deck-*` specs, `reachability`, `screen-layout`: they set their own
 *   layout and already run in the parity job.
 * - `server-rail`, `member-list`, `member-list-scale`: their parts that draw
 *   the layout are Classic-only.
 * - `mobile-layout`, `phone-panels`: phones run Classic.
 * - Specs whose subject is Classic's own chrome; the `deck-*` spec named here
 *   covers the Deck counterpart:
 *   - `main-layout` (member column and its sizing): `deck-buddies`, `deck-fold`
 *   - `sidebar-menus` (DM row menus, member section): `deck-direct`, `deck-buddies`
 *   - `sidebar-header` (the unified sidebar header): `deck-header`
 *   - `channel-sidebar` (Classic channel list): `deck-tree`
 *   - `responsive-nav` (the narrow-width drawer): `deck-tabs`, `deck-header`
 *   - `shell-polish` (embedded DM preview, list scroll): `deck-direct`, `deck-tree`
 *   - `navigation` (server menu entries, header action row, Classic DM round trip):
 *     `deck-header`, `deck-tabs`, `deck-direct`
 * - The DM specs (`dm-system`, `dm-calls`, `message-requests`) stay: DMs are a
 *   feature both layouts keep. They reach the DM list through the layout-neutral
 *   helpers in `tests/e2e/helpers.ts`; the cases about Classic's own DM chrome
 *   skip under Deck with a reason.
 */
const DECK_SPECS = [
  "a11y-smoke.spec.ts",
  "chat-header.spec.ts",
  "user-bar.spec.ts",
  "voice-widget.spec.ts",
  "voice-channel.spec.ts",
  "dm-system.spec.ts",
  "dm-calls.spec.ts",
  "message-requests.spec.ts",
  "search-overlay.spec.ts",
  "settings-overlay.spec.ts",
  "overlays.spec.ts",
  "connected-overlay.spec.ts",
  "video-grid.spec.ts",
  "context-menu-keyboard.spec.ts",
  "banners-toasts.spec.ts",
  "health-status.spec.ts",
  "forums.spec.ts",
  "server-profiles.spec.ts",
  "layout-fixture.spec.ts",
];

for (const name of DECK_SPECS) {
  // A renamed or deleted spec would otherwise leave the list matching nothing, silently.
  if (!existsSync(fromClientRoot(`tests/e2e/${name}`)))
    throw new Error(`playwright.config.deck.ts lists ${name}, which does not exist`);
}

export default defineConfig<{ screenLayout: ScreenLayoutOption }>({
  ...prod,
  outputDir: fromClientRoot("test-results/deck"),
  reporter: process.env.CI
    ? [
        ["html", { open: "never", outputFolder: fromClientRoot("playwright-report/deck") }],
        ["junit", { outputFile: fromClientRoot("test-results/deck-junit.xml") }],
      ]
    : [
        ["list"],
        ["html", { open: "never", outputFolder: fromClientRoot("playwright-report/deck") }],
      ],
  use: { ...prod.use, screenLayout: "deck" },
  testMatch: DECK_SPECS,
});
