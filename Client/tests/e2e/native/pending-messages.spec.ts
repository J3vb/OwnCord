import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startNativeApp, withNativeArtifacts } from "../support/native-app";

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

test("pending message encrypted native storage survives process restart, isolates owners and deletes durably", async ({}, info) => {
  test.setTimeout(180_000);
  const owner = { host: `pending-${randomUUID()}.invalid:55000`, userId: 71 };
  const otherAccount = { ...owner, userId: 72 };
  const otherServer = { ...owner, host: owner.host.replace(":55000", ":55001") };
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
        await nativeInvoke(app!.page, "save_pending_messages", { ...owner, value });
        expect(await nativeInvoke(app!.page, "load_pending_messages", owner)).toBe(value);
      },
      info,
    );
    await app.close({ preserveProfile: true });

    app = await startNativeApp(undefined, { preserveProfile: true });
    await withNativeArtifacts(
      app,
      async () => {
        expect(await nativeInvoke(app!.page, "load_pending_messages", owner)).toBe(value);
        expect(await nativeInvoke(app!.page, "load_pending_messages", otherAccount)).toBeNull();
        expect(await nativeInvoke(app!.page, "load_pending_messages", otherServer)).toBeNull();
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
        expect(await nativeInvoke(app!.page, "load_pending_messages", owner)).toBeNull();
      },
      info,
    );
  } finally {
    if (app && !app.page.isClosed()) {
      await nativeInvoke(app.page, "delete_pending_messages", owner).catch(() => undefined);
    }
    await app?.close();
  }
});
