import { configureNativeServer } from "./native/helpers";
import { startTestServer, type TestServer } from "./support/server";
import { test as base, type Page, type BrowserContext } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { startNativeApp, withNativeArtifacts, type NativeApp } from "./support/native-app";

type Fixtures = {
  nativeApp: NativeApp;
  nativePage: Page;
  nativeContext: BrowserContext;
  tauriProcess: ChildProcess;
};
export const test = base.extend<Fixtures, { nativeServer: TestServer }>({
  nativeServer: [
    async ({}, use) => {
      const server = await startTestServer({ tls: true });
      configureNativeServer(server.origin);
      process.env.OWNCORD_SERVER_URL = server.origin.replace("https://", "");
      process.env.OWNCORD_TEST_USER = "alice";
      process.env.OWNCORD_TEST_PASS = "OwnCord-E2E-pass-123!";
      try {
        await use(server);
      } finally {
        await server.close();
      }
    },
    { scope: "worker", timeout: 90_000 },
  ],
  nativeApp: async ({ nativeServer }, use) => {
    void nativeServer;
    const app = await startNativeApp();
    try {
      await use(app);
    } finally {
      await app.close();
    }
  },
  nativePage: async ({ nativeApp }, use, info) => {
    await withNativeArtifacts(nativeApp, () => use(nativeApp.page), info);
  },
  nativeContext: async ({ nativePage }, use) => {
    await use(nativePage.context());
  },
  tauriProcess: async ({ nativeApp }, use) => {
    await use(nativeApp.process);
  },
});
export { expect } from "@playwright/test";
