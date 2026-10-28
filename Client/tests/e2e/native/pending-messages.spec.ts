import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startNativeApp, withNativeArtifacts } from "../support/native-app";
import { startTestServer } from "../support/server";

type Owner = { host: string; userId: number };
async function nativeInvoke(page: Page, command: string, args: Owner & { value?: string }) {
  await page.waitForFunction(
    () =>
      typeof (
        window as unknown as {
          __TAURI_INTERNALS__?: { invoke?: unknown };
        }
      ).__TAURI_INTERNALS__?.invoke === "function",
  );
  return page.evaluate(
    ({ command, args }) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke(command: string, args: unknown): Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
}

// The pending-message commands only reach the signed-in server, so each
// launch signs in first. A preserved profile already trusts the certificate.
// Auto connect stays off so each relaunch shows the connect page again.
async function signIn(page: Page, host: string): Promise<void> {
  await expect(page.locator("#host")).toBeEditable();
  await page.locator("#host").fill(host);
  await page.locator("#username").fill("alice");
  await page.locator("#password").fill("OwnCord-E2E-pass-123!");
  await page.locator("#auto-connect").uncheck();
  const submit = page.locator("button.btn-primary[type='submit']");
  const dialog = page.getByRole("dialog", { name: "New Server Certificate" });
  const layout = page.getByTestId("app-layout");
  await submit.click();
  await expect(dialog.or(layout)).toBeVisible({ timeout: 30_000 });
  if (await dialog.isVisible()) {
    await dialog.getByRole("button", { name: "Trust This Certificate", exact: true }).click();
    await expect(dialog).toBeHidden();
    await submit.click();
  }
  await expect(layout).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".channel-item").filter({ visible: true }).first()).toBeVisible({
    timeout: 15_000,
  });
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
test("pending message encrypted native storage survives process restart, isolates owners and deletes durably", async ({}, info) => {
  test.setTimeout(240_000);
  const server = await startTestServer({ tls: true });
  const host = server.origin.replace("https://", "");
  const owner = { host, userId: 71 };
  const otherAccount = { ...owner, userId: 72 };
  const otherServer = { ...owner, host: `pending-${randomUUID()}.invalid:55001` };
  const createdAt = Date.now();
  // Windows Credential Manager's entry limit is smaller than this blob. A
  // process restart therefore exercises the real verified encrypted fallback,
  // not the JS Map used by the real-server browser transport fixture.
  const value = JSON.stringify([
    {
      clientMessageId: `${createdAt}:${randomUUID()}`,
      channelId: 5,
      createdAt,
      content: "private pending message ".repeat(300),
    },
  ]);
  let app: Awaited<ReturnType<typeof startNativeApp>> | undefined;
  try {
    app = await startNativeApp();
    await withNativeArtifacts(
      app,
      async () => {
        // Before any verified sign-in nothing is reachable.
        await expect(
          nativeInvoke(app!.page, "save_pending_messages", { ...owner, value }),
        ).rejects.toThrow(/not the active session host/);
        await signIn(app!.page, host);
        await nativeInvoke(app!.page, "save_pending_messages", { ...owner, value });
        expect(await nativeInvoke(app!.page, "load_pending_messages", owner)).toBe(value);
        await expect(
          nativeInvoke(app!.page, "save_pending_messages", { ...otherServer, value }),
        ).rejects.toThrow(/not the active session host/);
      },
      info,
    );
    await app.close({ preserveProfile: true });

    app = await startNativeApp(undefined, { preserveProfile: true });
    await withNativeArtifacts(
      app,
      async () => {
        await signIn(app!.page, host);
        expect(await nativeInvoke(app!.page, "load_pending_messages", owner)).toBe(value);
        expect(await nativeInvoke(app!.page, "load_pending_messages", otherAccount)).toBeNull();
        await expect(nativeInvoke(app!.page, "load_pending_messages", otherServer)).rejects.toThrow(
          /not the active session host/,
        );
        // Native limits apply even when a caller bypasses the TypeScript queue.
        await expect(
          nativeInvoke(app!.page, "save_pending_messages", {
            ...owner,
            value: JSON.stringify(["x".repeat(128 * 1024)]),
          }),
        ).rejects.toThrow();
        expect(await nativeInvoke(app!.page, "load_pending_messages", owner)).toBe(value);
        await nativeInvoke(app!.page, "delete_pending_messages", owner);
      },
      info,
    );
    await app.close({ preserveProfile: true });

    app = await startNativeApp(undefined, { preserveProfile: true });
    await withNativeArtifacts(
      app,
      async () => {
        await signIn(app!.page, host);
        expect(await nativeInvoke(app!.page, "load_pending_messages", owner)).toBeNull();
      },
      info,
    );
  } finally {
    if (app && !app.page.isClosed()) {
      await nativeInvoke(app.page, "delete_pending_messages", owner).catch(() => undefined);
    }
    await app?.close();
    await server.close();
  }
});
