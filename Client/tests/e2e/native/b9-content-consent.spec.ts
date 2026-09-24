/**
 * B9-8 native evidence: in the real app, a message that links external
 * content reaches the native broker only after the viewer consents, only for
 * the item they activated under "Ask each time", and not again after the Text &
 * Images reset. The hosts are `.invalid`, so an admitted call is refused by
 * the broker without leaving the machine — the count of broker invocations is
 * what this proves, not their result.
 */
import { test, expect, type Page } from "@playwright/test";
import { openSettings, switchSettingsTab } from "../helpers";
import { startNativeApp, withNativeArtifacts } from "../support/native-app";
import { startTestServer } from "../support/server";
import { configureNativeServer, nativeLoginAndReady, waitForMessages } from "./helpers";

declare global {
  interface Window {
    __brokerUrls?: string[];
  }
}

const PREVIEW = "https://preview.invalid/story";
const IMAGE = "https://images.invalid/cat.png";

/** Record every URL the renderer hands the native broker. Tauri seals
 *  `__TAURI_INTERNALS__`, so the genuine IPC transport (a `window.fetch` to the
 *  `ipc.localhost` protocol on Windows) is observed and delegated unchanged. */
async function observeBroker(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nativeFetch = window.fetch;
    const urls: string[] = [];
    window.__brokerUrls = urls;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const ipc = /^https?:\/\/ipc\.localhost\/(external_preview|external_image)$/.exec(url);
      if (ipc && typeof init?.body === "string") {
        const args = JSON.parse(init.body) as { url?: string; handle?: string };
        // An empty preview URL only rotates the cache partition; no network work.
        const target = args.url ?? args.handle ?? "";
        if (target !== "") urls.push(target);
      }
      return nativeFetch(input, init);
    };
  });
}

const brokerUrls = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(window.__brokerUrls ?? [])]);

// eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
test("external content reaches the native broker only after consent (B9-8)", async ({}, info) => {
  const server = await startTestServer({ tls: true });
  let app: Awaited<ReturnType<typeof startNativeApp>> | undefined;
  try {
    configureNativeServer(server.origin);
    app = await startNativeApp();
    await withNativeArtifacts(
      app,
      async () => {
        const page = app!.page;
        await nativeLoginAndReady(page);
        await waitForMessages(page);
        await observeBroker(page);

        const textarea = page.getByTestId("msg-textarea");
        await textarea.fill(`b9-8 ${PREVIEW} ${IMAGE}`);
        await textarea.press("Enter");

        const loadPreview = page.getByRole("button", {
          name: "Load external content from preview.invalid",
        });
        const loadImage = page.getByRole("button", {
          name: "Load external content from images.invalid",
        });
        await expect(loadPreview).toBeVisible();
        await expect(loadImage).toBeVisible();

        // Focus and hover grant nothing.
        await loadPreview.focus();
        await loadImage.hover();
        await page.waitForTimeout(1000);
        expect(await brokerUrls(page)).toEqual([]);

        // Escape chooses nothing and returns focus to the item.
        await loadPreview.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: "Load external content on this server?" });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("can see your IP address");
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(loadPreview).toBeFocused();
        expect(await brokerUrls(page)).toEqual([]);

        // "Ask each time" admits the activated item only.
        await page.keyboard.press("Enter");
        await dialog.getByRole("button", { name: "Ask each time" }).click();
        await expect.poll(() => brokerUrls(page)).toContain(PREVIEW);
        await expect(loadPreview).toBeHidden();
        await expect(loadImage).toBeVisible();
        expect(await brokerUrls(page)).not.toContain(IMAGE);

        // The Text & Images reset re-conceals it; nothing further is fetched.
        await openSettings(page);
        await switchSettingsTab(page, "Text & Images");
        await page.getByRole("button", { name: "Reset external content consent" }).click();
        await expect(page.getByRole("status").filter({ hasText: "Consent reset" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(loadPreview).toBeVisible();
        const settled = (await brokerUrls(page)).length;
        await page.waitForTimeout(1000);
        expect(await brokerUrls(page)).toHaveLength(settled);
        await info.attach("broker-invocations", {
          body: JSON.stringify(await brokerUrls(page), null, 2),
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
