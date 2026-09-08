import { configureNativeServer } from "./native/helpers";
import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";
import { startNativeApp, withNativeArtifacts, type NativeApp } from "./support/native-app";
import { startTestServer, type TestServer } from "./support/server";

import { startTcpGate } from "./support/tcp-gate";

type Fixtures = { nativePage: Page; nativeContext: BrowserContext };
type Workers = {
  nativeApp: NativeApp;
  nativeServer: TestServer & { network: Awaited<ReturnType<typeof startTcpGate>> };
};

export const test = base.extend<Fixtures, Workers>({
  nativeServer: [
    async ({}, use) => {
      const server = await startTestServer({ tls: true, livekit: true });
      const network = await startTcpGate(server.port);
      configureNativeServer(network.origin);
      process.env.OWNCORD_SERVER_URL = network.origin.replace("https://", "");
      process.env.OWNCORD_TEST_USER = "alice";
      process.env.OWNCORD_TEST_PASS = "OwnCord-E2E-pass-123!";
      try {
        await use(Object.assign(server, { network }));
      } finally {
        await network.close();
        await server.close();
      }
    },
    { scope: "worker", timeout: 90_000 },
  ],
  nativeApp: [
    async ({ nativeServer }, use) => {
      void nativeServer;
      const app = await startNativeApp();
      try {
        await use(app);
      } finally {
        await app.close();
      }
    },
    { scope: "worker", timeout: 90_000 },
  ],
  nativePage: async ({ nativeApp }, use, testInfo) => {
    // Reset transient UI using user actions; retain login in the same process.
    await nativeApp.page.keyboard.press("Escape");
    const disconnect = nativeApp.page.locator(
      ".voice-widget.visible button[aria-label='Disconnect']",
    );
    if (await disconnect.isVisible()) {
      await disconnect.click();
      await expect(nativeApp.page.locator(".voice-widget")).not.toHaveClass(/visible/);
    }
    await withNativeArtifacts(nativeApp, () => use(nativeApp.page), testInfo);
  },
  nativeContext: async ({ nativePage }, use) => {
    await use(nativePage.context());
  },
});
export { expect } from "@playwright/test";
