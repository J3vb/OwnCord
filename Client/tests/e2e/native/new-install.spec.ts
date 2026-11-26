/**
 * Native E2E: a new install of the shipped build.
 *
 * On a cleared profile with no layout seeded, the real binary and WebView2
 * start the way a first install does: Command Deck and the Gunmetal theme,
 * with both stored, and the new-install notification level. Launched by hand
 * rather than through the `nativeApp` fixture, which holds the CDP port for
 * its own seeded app.
 */

import { test, expect } from "@playwright/test";
import { startNativeApp, withNativeArtifacts, type NativeApp } from "../support/native-app";

// eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
test("a cleared profile starts on Command Deck and Gunmetal", async ({}, info) => {
  test.setTimeout(120_000);
  let app: NativeApp | undefined;
  try {
    app = await startNativeApp(undefined, { screenLayout: "fresh" });
    const { page } = app;
    await withNativeArtifacts(
      app,
      async () => {
        await expect(page.locator("html")).toHaveClass(/layout-deck/);
        await expect(page.locator("body")).toHaveClass(/theme-gunmetal/);
        const stored = await page.evaluate(() => ({
          layout: localStorage.getItem("owncord:settings:screenLayout"),
          theme: localStorage.getItem("owncord:theme:active"),
          level: localStorage.getItem("owncord:settings:notificationLevel"),
        }));
        expect(stored).toEqual({
          layout: JSON.stringify("deck"),
          theme: "gunmetal",
          level: JSON.stringify("mentions"),
        });
      },
      info,
    );
  } finally {
    await app?.close();
  }
});
