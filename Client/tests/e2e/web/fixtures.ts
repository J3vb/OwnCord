import { test as base, expect, type Page } from "@playwright/test";
import { startTestServer, TEST_PASSWORD, type TestServer } from "../support/server";

type Fixtures = {
  /** A real server with the browser client on, serving the embedded bundle over its own TLS. */
  server: TestServer;
  /** Start the server with a LiveKit SFU beside it (needs OWNCORD_E2E_LIVEKIT_BINARY). */
  media: boolean;
};

export const test = base.extend<Fixtures>({
  media: [false, { option: true }],
  server: async ({ media }, use, info) => {
    const server = await startTestServer({ tls: true, browserClient: true, livekit: media });
    try {
      await use(server);
    } finally {
      await info.attach("server-log", { body: server.log(), contentType: "text/plain" });
      await server.close();
    }
  },
  baseURL: async ({ server }, use) => {
    await use(server.origin);
  },
});

export { expect };

/**
 * Sign in on the portal's connect page. The host field is filled and hidden
 * there (the page is served by the server it talks to), so only the account is
 * typed. "Stay signed in" is ticked by default and is left as it is unless
 * `staySignedIn` says otherwise.
 */
export async function signIn(
  page: Page,
  username = "alice",
  options: { staySignedIn?: boolean } = {},
): Promise<void> {
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(TEST_PASSWORD);
  if (options.staySignedIn !== undefined) {
    await page.locator("#auto-connect").setChecked(options.staySignedIn);
  }
  await page.locator("button[type='submit']").click();
  await expect(page.getByTestId("app-layout")).toBeVisible();
}

/** Send `text` from the composer and wait for it to show in the list. */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.locator("[data-testid='message-input'] textarea");
  await input.fill(text);
  await input.press("Enter");
  await expect(page.locator(".msg-text", { hasText: text })).toHaveCount(1);
}
