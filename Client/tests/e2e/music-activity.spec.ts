/**
 * WP 8.10c: the accessibility journey for the "Listening to music" UI.
 *
 * The journey: this device is playing a song, so Settings > Advanced >
 * Activity shows the share switch, the "Detected now" line and "Your players"
 * with a "Show to others" switch each; another member is listening, so the
 * member row carries a "Listening to <player>" line and their profile popup
 * carries the song card. The shared B9 accessibility checks (names, keyboard
 * reach, focus ring, Q1 text contrast) run on each of those roots in the light
 * and the dark theme. Drives the real app through the mocked Tauri transport;
 * `detectMedia` is the opt-in that makes the mocked song read answer "playing".
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  navigateToMainPageReady,
  openSettings,
  switchSettingsTab,
} from "./helpers";
import {
  Q1,
  findUnnamedControls,
  focusIndicator,
  keyboardReachable,
  setAppearance,
  textContrast,
} from "./support/accessibility";

const THEMES = ["light", "dark"] as const;

const MUSIC_CAPABILITIES = { listening_activity: true, game_activity: true };

async function start(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: { messages: [], has_more: false } },
      ],
      simulateWsFlow: true,
      detectMedia: {
        state: "playing",
        title: "Song",
        artist: "Artist",
        player: "Spotify",
        playerId: "Spotify.exe",
        positionMs: 30_000,
        durationMs: 200_000,
      },
      readyOverrides: {
        capabilities: { ...MUSIC_CAPABILITIES, message_deduplication: true },
        listening: [
          {
            user_id: 2,
            title: "Other Song",
            artist: "Other Artist",
            player: "Apple Music",
            started_at: Date.now() - 20_000,
            duration_ms: 240_000,
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await setAppearance(page, { theme, highContrast: false, accent: null });
  await navigateToMainPageReady(page);
}

for (const theme of THEMES) {
  test.describe(`music activity (${theme})`, () => {
    test("settings rows: detected song, players, switches", async ({ page }) => {
      await start(page, theme);
      await openSettings(page);
      await switchSettingsTab(page, "Advanced");

      const pane = page.locator(".settings-content");
      const row = pane.getByTestId("music-activity-row");
      await expect(row).toBeVisible();
      await expect(row).toContainText("Share the music you're listening to");
      const detected = pane.getByTestId("music-activity-detected");
      await expect(detected).toContainText("Song");
      await expect(detected).toContainText("Spotify");

      const players = pane.getByTestId("music-activity-players");
      const playerRow = players.getByTestId("player-row").first();
      await expect(playerRow).toBeVisible();
      await expect(playerRow.getByTestId("player-row-name")).toHaveText("Spotify");

      const shareSwitch = row.getByRole("switch");
      const playerSwitch = playerRow.getByRole("switch");
      await expect(shareSwitch).toHaveAttribute("aria-checked", "true");
      await expect(playerSwitch).toHaveAttribute("aria-checked", "true");

      const failures: string[] = [];
      for (const root of [row, players]) {
        expect(await findUnnamedControls(root)).toEqual([]);
      }
      expect(await keyboardReachable(page, shareSwitch)).toBe(true);
      expect(await keyboardReachable(page, playerSwitch)).toBe(true);

      for (const [name, target] of [
        ["share switch", shareSwitch],
        ["player switch", playerSwitch],
      ] as const) {
        await target.focus();
        const ring = await focusIndicator(page);
        for (const p of ring.problems) failures.push(`focus ${name}: ${p}`);
      }

      for (const [name, locator] of [
        ["share label", row.locator(".setting-label")],
        ["share description", row.locator(".setting-desc").first()],
        ["detected now", detected],
        ["players title", pane.locator(".game-list-title", { hasText: "Your players" })],
        ["player name", playerRow.getByTestId("player-row-name")],
      ] as const) {
        const { ratio } = await textContrast(locator);
        if (ratio < Q1.text) failures.push(`${name} ${ratio.toFixed(2)} < ${Q1.text}`);
      }
      expect(failures).toEqual([]);

      // The switch works from the keyboard and reports its state.
      await playerSwitch.focus();
      await page.keyboard.press("Space");
      await expect(playerSwitch).toHaveAttribute("aria-checked", "false");
    });

    test("member row and profile popup carry the song card", async ({ page }) => {
      await start(page, theme);

      const member = page.locator("[data-testid='member-2']");
      await expect(member).toContainText("Listening to Apple Music");

      const failures: string[] = [];
      const line = member.getByText("Listening to Apple Music");
      const { ratio: lineRatio } = await textContrast(line);
      if (lineRatio < Q1.text) failures.push(`member line ${lineRatio.toFixed(2)} < ${Q1.text}`);

      await member.click();
      const popup = page.getByTestId("user-profile-popup");
      await expect(popup).toBeVisible();
      const card = popup.getByTestId("upp-listening");
      await expect(card).toBeVisible();
      await expect(card).toContainText("Other Song");
      await expect(card).toContainText("Other Artist");

      expect(await findUnnamedControls(popup)).toEqual([]);
      for (const [name, locator] of [
        ["card label", card.locator(".upp-listening-label")],
        ["card title", card.locator(".upp-listening-title")],
        ["card artist", card.locator(".upp-listening-artist")],
      ] as const) {
        const { ratio } = await textContrast(locator);
        if (ratio < Q1.text) failures.push(`${name} ${ratio.toFixed(2)} < ${Q1.text}`);
      }
      expect(failures).toEqual([]);
    });
  });
}
