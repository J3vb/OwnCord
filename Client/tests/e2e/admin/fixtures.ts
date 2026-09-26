import { test as base, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "../support/server";

export const test = base.extend<{ adminServer: TestServer; runtimeErrors: void }>({
  runtimeErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // The admin CSP is script-src 'self'. A refused inline handler or script
      // raises no pageerror — the control just goes dead — so the browser's
      // CSP report on the console fails the journey instead.
      page.on("console", (message) => {
        if (message.type() === "error" && message.text().includes("Content Security Policy")) {
          errors.push(message.text());
        }
      });
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
