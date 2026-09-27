import { test as base, expect, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "../support/server";

// The admin suites run against a real server and database. `test` starts an
// empty one and owns the first-run wizard (admin-panel.spec.ts); `seededTest`
// starts one seeded through real HTTP routes (owner alice, a second member and
// two channels) so a per-page journey does not replay the wizard, and points
// baseURL at it so a relative goto lands on the right process.
const baseTest = base.extend<{ runtimeErrors: void }>({
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
});

export const test = baseTest.extend<{ adminServer: TestServer }>({
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

export const seededTest = baseTest.extend<{ seededAdminServer: TestServer }>({
  seededAdminServer: async ({}, use, info) => {
    const server = await startTestServer({ seed: true });
    try {
      await use(server);
    } finally {
      await info.attach("server-log", { body: server.log(), contentType: "text/plain" });
      await server.close();
    }
  },
  baseURL: async ({ seededAdminServer }, use) => {
    await use(seededAdminServer.origin);
  },
});

/** Land on the panel already signed in as the seeded owner. */
export async function signInAsOwner(page: Page, server: TestServer): Promise<void> {
  if (!server.owner) throw new Error("seededAdminServer did not create an owner");
  await page.addInitScript(
    (token) => localStorage.setItem("admin_token", token),
    server.owner.token,
  );
  await page.goto("/admin/");
  await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });
}

export { expect };
