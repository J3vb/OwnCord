import { test as base, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "../support/server";

export const test = base.extend<{ adminServer: TestServer; runtimeErrors: void }>({
  runtimeErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await use();
      expect(errors, "Unhandled admin browser errors").toEqual([]);
    },
    { auto: true },
  ],
  adminServer: async ({}, use, info) => {
    const server = await startTestServer({ seed: false });
    try {
      await use(server);
    } finally {
      await info.attach("server-log", { body: server.log(), contentType: "text/plain" });
      await server.close();
    }
  },
  baseURL: async ({ adminServer }, use) => {
    await use(adminServer.origin);
  },
});
export { expect } from "@playwright/test";
