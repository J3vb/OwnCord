import { installMediaProbe } from "../support/media";
import { test as base, expect, type Page } from "@playwright/test";
import { startTestServer, TEST_PASSWORD, type TestServer } from "../support/server";
import { installRealTransport } from "../support/real-transport";

type Transport = Awaited<ReturnType<typeof installRealTransport>>;
type Fixtures = {
  server: TestServer;
  alice: Page;
  bob: Page;
  aliceTransport: Transport;
  bobTransport: Transport;
  media: boolean;
};
export async function login(page: Page, server: TestServer, username: string) {
  await page.goto("/");
  await page.locator("#host").fill(`127.0.0.1:${server.port}`);
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(TEST_PASSWORD);
  await page.locator("button[type='submit']").click();
  await expect(page.getByTestId("app-layout")).toBeVisible();
  await expect(
    page.locator(".channel-item:not(.voice)").filter({ hasText: "general" }),
  ).toBeVisible();
}

export const test = base.extend<Fixtures>({
  media: [false, { option: true }],
  server: async ({ media }, use, info) => {
    const server = await startTestServer({ livekit: media });
    try {
      await use(server);
    } finally {
      await info.attach("server-log", { body: server.log(), contentType: "text/plain" });
      await server.close();
    }
  },
  aliceTransport: async ({ page, server, media }, use) => {
    if (media) await installMediaProbe(page);
    const transport = await installRealTransport(page, server);
    try {
      await use(transport);
    } finally {
      await transport.close();
      expect(transport.errors).toEqual([]);
    }
  },
  alice: async ({ page, server, aliceTransport }, use) => {
    void aliceTransport;
    await login(page, server, "alice");
    await use(page);
  },
  bobTransport: async ({ browser, server, media }, use) => {
    const context = await browser.newContext({
      baseURL: "http://localhost:4173",
      permissions: ["microphone", "camera"],
    });
    const page = await context.newPage();
    if (media) await installMediaProbe(page);
    const transport = await installRealTransport(page, server);
    Object.assign(transport, { page });
    try {
      await use(transport);
    } finally {
      await transport.close();
      await context.close();
      expect(transport.errors).toEqual([]);
    }
  },
  bob: async ({ bobTransport, server }, use) => {
    const page = (bobTransport as Transport & { page: Page }).page;
    await login(page, server, "bob");
    await use(page);
  },
});
export { expect } from "@playwright/test";
