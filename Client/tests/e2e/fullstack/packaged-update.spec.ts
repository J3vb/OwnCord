import { childPids, processIsAlive } from "../support/process";
import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { test as base, expect, login } from "./fixtures";
import { preparePackagedServer } from "../support/packaged-server";
import { startTestServer, TEST_PASSWORD } from "../support/server";
import { expectDecodedMedia, joinVoice } from "../support/media";

type Package = Awaited<ReturnType<typeof preparePackagedServer>>;
const test = base.extend<{ release: Package }>({
  release: [
    async ({}, use) => {
      const release = await preparePackagedServer();
      try {
        await use(release);
      } finally {
        await release.close();
      }
    },
    { timeout: 240_000 },
  ],
  server: async ({ release, media }, use, info) => {
    const server = await startTestServer({
      binary: release.binary,
      env: release.env,
      livekit: media,
    });
    try {
      await use(server);
    } finally {
      await info.attach("update-process-log", { body: server.log(), contentType: "text/plain" });
      // The successor is detached by production code and must stop before
      // the shared database/temp directory is removed.
      await release.close();
      await server.close();
    }
  },
});

for (const media of [false, true]) {
  test.describe(media ? "with managed LiveKit" : "packaged server", () => {
    test.use({ media });
    test("signed update rejects broken downloads, replaces the running executable and restores clients", async ({
      alice,
      bob,
      browser,
      server,
      release,
    }) => {
      test.setTimeout(360_000);
      const text = `persist-through-update-${crypto.randomUUID()}`;
      const input = alice.locator("[data-testid='message-input'] textarea");
      await input.fill(text);
      await input.press("Enter");
      await expect(bob.locator(".msg-text", { hasText: text })).toHaveCount(1);
      if (media) {
        await joinVoice(alice);
        await joinVoice(bob);
        await expectDecodedMedia(bob);
      }
      const companions = media ? await childPids((await release.pids())[0]!) : [];
      if (media) expect(companions).toHaveLength(1);
      const original = createHash("sha256")
        .update(await readFile(release.binary))
        .digest("hex");
      const owner = server.owner!.token;
      for (const fault of ["corrupt", "interrupted"] as const) {
        const downloads = release.requests.filter(
          (path) => path.endsWith(".tar.gz") || path.endsWith("/chatserver.exe"),
        ).length;
        release.fault(fault);
        const response = await fetch(`${server.origin}/admin/api/updates/apply`, {
          method: "POST",
          headers: { Authorization: `Bearer ${owner}` },
          signal: AbortSignal.timeout(45_000),
        });
        expect(response.status).toBe(502);
        expect(
          release.requests.filter(
            (path) => path.endsWith(".tar.gz") || path.endsWith("/chatserver.exe"),
          ).length,
        ).toBe(downloads + 1);
        expect(await response.json()).toMatchObject({ error: "DOWNLOAD_FAILED" });
        expect(
          createHash("sha256")
            .update(await readFile(release.binary))
            .digest("hex"),
        ).toEqual(original);
        await expect
          .poll(async () => {
            try {
              await access(`${release.binary}.new`);
              return true;
            } catch {
              return false;
            }
          })
          .toBe(false);
        expect((await server.api("/admin/api/updates", undefined, owner)).current).toBe(
          "v1.2.0-alpha.4",
        );
        await expect(bob.getByTestId("app-layout")).toBeVisible();
      }
      release.fault("none");
      const admin = await browser.newPage();
      try {
        await admin.goto(`${server.origin}/admin/`);
        await admin.locator("#loginUser").fill("alice");
        await admin.locator("#loginPass").fill(TEST_PASSWORD);
        await admin.locator("#loginBtn").click();
        await admin.getByRole("tab", { name: "Updates", exact: true }).click();
        await admin.getByRole("button", { name: "Apply Update & Restart", exact: true }).click();
        const applied = admin.waitForResponse(
          (response) =>
            response.url().endsWith("/updates/apply") && response.request().method() === "POST",
        );
        await admin.getByRole("button", { name: "Update & Restart", exact: true }).click();
        expect((await applied).status()).toBe(200);
        await expect
          .poll(
            async () => {
              try {
                return (await server.api("/admin/api/updates", undefined, owner)).current;
              } catch {
                return "restarting";
              }
            },
            { timeout: 60_000 },
          )
          .toBe(`v${release.version}`);
        expect(server.exited()).toBe(true);
        const pids = await release.pids();
        expect(pids).toHaveLength(2);
        expect(new Set(pids).size).toBe(2);
        if (media) {
          await expect.poll(() => companions.some(processIsAlive)).toBe(false);
          const successors = await childPids(pids[1]!);
          expect(successors).toHaveLength(1);
          expect(successors[0]).not.toBe(companions[0]);
        }
        expect(
          createHash("sha256")
            .update(await readFile(release.binary))
            .digest("hex"),
        ).not.toEqual(original);
        // Restart broadcasts can intentionally sign out clients. Re-authenticate
        // through the UI, then verify stored data and a new real WS delivery.
        await login(alice, server, "alice");
        await login(bob, server, "bob");
        await expect(bob.locator(".msg-text", { hasText: text })).toHaveCount(1);
        const next = `new-process-${crypto.randomUUID()}`;
        await input.fill(next);
        await input.press("Enter");
        await expect(bob.locator(".msg-text", { hasText: next })).toHaveCount(1);
        if (media) {
          await joinVoice(alice);
          await joinVoice(bob);
          await expectDecodedMedia(alice);
          await expectDecodedMedia(bob);
        }
        const audit = await server.api("/admin/api/audit-log", undefined, owner);
        expect(audit.some((entry: { action: string }) => entry.action === "update_applied")).toBe(
          true,
        );
      } finally {
        await admin.close();
      }
    });
  });
}
