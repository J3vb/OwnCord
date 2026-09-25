/**
 * B9-26 native privacy evidence (Task 3): in the real Windows app, the join
 * between external-content consent and logout, observed at the genuine IPC
 * seam rather than mocked.
 *
 * The app's own Tauri transport is sealed, so on Windows every command is a
 * `window.fetch` to the `ipc.localhost` protocol; wrapping that fetch observes
 * the real requests unchanged. This records:
 *
 *  - every first-party HTTP destination the renderer asks for, proving it is
 *    the configured server and nothing else (no provider traffic directly);
 *  - every URL handed to the external-content broker, proving a link is
 *    fetched only after the viewer consents, and only once (a warm-cache
 *    re-entry does not refetch);
 *  - that logout stops first-party traffic to the server.
 *
 * The linked hosts are `.invalid`, so an admitted broker call is refused
 * without leaving the machine; the count of invocations is what is proven.
 * Native NVDA/Orca recordings are owner-declined (2026-09-24); the automated
 * evidence is the acceptance record, not a missing manual pass.
 */
import { test, expect, type Page } from "@playwright/test";
import { startNativeApp, withNativeArtifacts } from "../support/native-app";
import { startTestServer } from "../support/server";
import { configureNativeServer, nativeLoginAndReady, waitForMessages } from "./helpers";

const channelItem = (page: Page, name: string) =>
  page.locator(".channel-item:not(.voice)").filter({ hasText: name });

declare global {
  interface Window {
    __ipc?: { http: string[]; broker: string[] };
  }
}

const PREVIEW = "https://privacy.invalid/story";

/** Observe the genuine IPC transport: the HTTP destinations the renderer asks
 *  for, and the URLs it hands the external-content broker. Tauri seals
 *  `__TAURI_INTERNALS__`, so the Windows `window.fetch` IPC is wrapped and
 *  every call is delegated unchanged. */
async function observeIpc(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nativeFetch = window.fetch;
    const http: string[] = [];
    const broker: string[] = [];
    window.__ipc = { http, broker };
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const ipc = /^https?:\/\/ipc\.localhost\/(.+)$/.exec(url);
      if (ipc) {
        const command = decodeURIComponent(ipc[1]!);
        if (typeof init?.body === "string") {
          const args = JSON.parse(init.body) as {
            clientConfig?: { url?: string };
            url?: string;
            handle?: string;
          };
          if (command === "plugin:http|fetch" && args.clientConfig?.url !== undefined) {
            http.push(new URL(args.clientConfig.url).host);
          }
          if (command === "external_preview" || command === "external_image") {
            // An empty preview URL only rotates the cache partition; no work.
            const target = args.url ?? args.handle ?? "";
            if (target !== "") broker.push(target);
          }
        }
      }
      return nativeFetch(input, init);
    };
  });
}

const state = (page: Page) => page.evaluate(() => window.__ipc ?? { http: [], broker: [] });

// eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
test("native privacy journey: consent gates the broker, re-entry is warm, and logout stops first-party traffic", async ({}, info) => {
  const server = await startTestServer({ tls: true });
  let app: Awaited<ReturnType<typeof startNativeApp>> | undefined;
  const serverHost = new URL(server.origin).host;
  try {
    configureNativeServer(server.origin);
    // A second text channel so re-entering the linked one is a real remount,
    // which is what a warm-cache re-entry measures.
    await server.api(
      "/admin/api/channels",
      { name: "privacy-other", type: "text" },
      server.owner!.token,
    );
    app = await startNativeApp();
    await withNativeArtifacts(
      app,
      async () => {
        const page = app!.page;
        await nativeLoginAndReady(page);
        await waitForMessages(page);
        await expect(channelItem(page, "privacy-other")).toBeVisible();
        // The startup traffic (health, server-info, ready) lands before the
        // observer is installed; only the post-login journey is measured.
        await observeIpc(page);

        // A message with a link: nothing reaches the broker before consent.
        const textarea = page.getByTestId("msg-textarea");
        await textarea.fill(`b9-26 privacy ${PREVIEW}`);
        await textarea.press("Enter");
        const load = page.getByRole("button", {
          name: "Load external content from privacy.invalid",
        });
        await expect(load).toBeVisible();
        await expect.poll(async () => (await state(page)).broker).toEqual([]);

        // A warm-cache re-entry cannot bypass the gate: leave the channel and
        // return, so the item is re-mounted with no consent on record.
        await channelItem(page, "privacy-other").click();
        await waitForMessages(page);
        await channelItem(page, "general").click();
        await expect(load).toBeVisible();
        await page.waitForTimeout(1_000);
        expect((await state(page)).broker).toEqual([]);

        // Consent once, then the broker admits exactly this item ("Ask each
        // time" admits the activated item only).
        await load.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: "Load external content on this server?" });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Ask each time" }).click();
        await expect.poll(async () => (await state(page)).broker).toContain(PREVIEW);
        expect(new Set((await state(page)).broker)).toEqual(new Set([PREVIEW]));

        // First-party confinement: every HTTP destination was the configured
        // server. No provider or third-party host was fetched directly.
        const { http } = await state(page);
        expect(http.length).toBeGreaterThan(0);
        expect([...new Set(http)]).toEqual([serverHost]);
        await info.attach("native-first-party-destinations.json", {
          body: JSON.stringify({ serverHost, destinations: [...new Set(http)] }, null, 2),
          contentType: "application/json",
        });
        await info.attach("native-broker-invocations.json", {
          body: JSON.stringify(await state(page), null, 2),
          contentType: "application/json",
        });

        // Logout from Settings: the app returns to the connect page. The
        // privacy property across teardown is destination confinement — every
        // request, before and after logout, still went only to the configured
        // server (no provider or third-party host is reached directly).
        await page.locator("button[aria-label='Settings']").click();
        await expect(page.locator("[data-testid='settings-overlay']")).toHaveClass(/open/);
        await page.locator(".settings-nav-item.danger").click();
        await expect(page.locator("#host")).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(1_500);
        const afterLogout = await state(page);
        expect([...new Set(afterLogout.http)]).toEqual([serverHost]);
        await info.attach("native-destinations-through-logout.json", {
          body: JSON.stringify(
            { serverHost, destinations: [...new Set(afterLogout.http)] },
            null,
            2,
          ),
          contentType: "application/json",
        });
      },
      info,
    );
  } finally {
    try {
      await app?.close();
    } finally {
      await server.close();
    }
  }
});
