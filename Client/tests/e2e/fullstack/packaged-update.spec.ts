import { childPids, processIsAlive } from "../support/process";
import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { test as base, expect } from "./fixtures";
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
      bobTransport,
      browser,
      server,
      release,
    }) => {
      test.setTimeout(360_000);
      const notices: Array<Record<string, unknown> | undefined> = [];
      bobTransport.filterServerMessages((message) => {
        if (message.type === "server_restart") notices.push(message.payload);
        return true;
      });
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
      // A managed LiveKit companion is spawned exactly when media is on; assert
      // the count in BOTH directions so a mis-wired media flag fails the test
      // instead of silently dropping the check.
      const companions = await childPids((await release.pids())[0]!);
      expect(companions).toHaveLength(media ? 1 : 0);
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
      // An operator watching the update from the admin Logs tab: its stream
      // stays open through the whole restart (SRV-06).
      const logs = await browser.newPage();
      try {
        await logs.goto(`${server.origin}/admin/`);
        await logs.locator("#loginUser").fill("alice");
        await logs.locator("#loginPass").fill(TEST_PASSWORD);
        await logs.locator("#loginBtn").click();
        await logs
          .getByRole("navigation", { name: "Admin sections" })
          .getByRole("button", { name: /^Server logs\b/ })
          .click();
        await expect(logs.locator("#logStatusText")).toHaveText("Connected");
        await admin.goto(`${server.origin}/admin/`);
        await admin.locator("#loginUser").fill("alice");
        await admin.locator("#loginPass").fill(TEST_PASSWORD);
        await admin.locator("#loginBtn").click();
        await admin
          .getByRole("navigation", { name: "Admin sections" })
          .getByRole("button", { name: /^Updates\b/ })
          .click();
        await admin.getByRole("button", { name: /^Update to v/ }).click();
        const applied = admin.waitForResponse(
          (response) =>
            response.url().endsWith("/updates/apply") && response.request().method() === "POST",
        );
        // The dialog backs the database up first by default (OP-11).
        await admin.getByRole("button", { name: "Back up and update", exact: true }).click();
        expect((await applied).status()).toBe(200);
        // ARCH-13: the busy dialog cannot be dismissed while the server
        // restarts (CLI-02) — Escape leaves the restart wait on screen.
        await expect(admin.locator("#restartWait")).toBeVisible();
        await admin.keyboard.press("Escape");
        await expect(admin.locator("#modal")).toHaveClass(/visible/);
        await expect(admin.locator("#restartWait")).toBeVisible();
        // ARCH-13 (ii): the stop is bounded even with the Logs stream open —
        // the 5 s update countdown, the swap, then a drain the stream no
        // longer holds and the hub's 5 s notice. Before SRV-06 the stream
        // held the drain for the whole 30 s shutdown budget.
        const appliedAt = Date.now();
        await expect.poll(() => server.exited(), { timeout: 45_000 }).toBe(true);
        expect(Date.now() - appliedAt).toBeLessThan(20_000);
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
        // ARCH-13 (i): the hub's own teardown notice reached the client after
        // the admin's announcement, and names the update rather than a stop
        // (CLI-02); (v): the drain ran on a live budget, so no audit row was
        // dropped.
        expect(notices).toEqual([
          { reason: "update", delay_seconds: 5 },
          { reason: "update", delay_seconds: 5 },
        ]);
        expect(server.log()).not.toContain("audit log dropped");
        expect(server.log()).not.toContain("flush lost audit entries");
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
        // ARCH-13 (iii): a planned restart keeps the session (Q4). Neither
        // client signed in with auto-connect, yet each reconnects on its own
        // into the channel it was in, never through the login form.
        for (const page of [alice, bob]) {
          await expect(page.locator(".reconnecting-banner")).not.toHaveClass(/visible/, {
            timeout: 60_000,
          });
          await expect(page.getByTestId("app-layout")).toBeVisible();
          await expect(page.locator("#password")).toHaveCount(0);
          await expect(
            page.locator(".channel-item.active:not(.voice)").filter({ hasText: "general" }),
          ).toBeVisible();
        }
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
        await logs.close();
        await admin.close();
      }
    });
  });
}
