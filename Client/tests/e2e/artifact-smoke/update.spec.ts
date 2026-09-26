/**
 * B7-17, release time only: the owner's update and rollback on the SHIPPED
 * artifacts. Install the previous published release, let it update itself to
 * the release being built (its real updater artifact and release signature,
 * served for the exact target the binary asks about), then roll back by
 * reinstalling the previous release over it.
 *
 * Needs signed artifacts, so the nightly never runs this project.
 */
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import {
  appVersion,
  artifactLogin,
  findAsset,
  installArtifact,
  killInstalled,
  launchArtifact,
  updaterTarget,
  waitFor,
  type ArtifactDriver,
} from "../support/artifact-app";
import { startNativeUpdateServer } from "../support/native-update-server";
import { startTestServer, TEST_PASSWORD } from "../support/server";

const CURRENT = process.env.OWNCORD_ARTIFACT_DIR ?? "";
const PREVIOUS = process.env.OWNCORD_PREVIOUS_ARTIFACT_DIR ?? "";
const updater = process.platform === "win32" ? ".nsis.zip" : ".AppImage.tar.gz";

// The previous release is the baseline this test updates FROM, not the build
// under test. Its bundled WebKit has lost the page within seconds of launch on
// the Linux runners (x64 and ARM64), before any of this release's code ran:
// WebDriver answers "invalid session id" (page crash or hang) or "unknown
// error". Only the baseline's launch and first interaction retry on that.
const BASELINE_SESSION_LOST = /WebDriver [\s\S]*"error":"(invalid session id|unknown error)"/;

const digest = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

test("the previous release updates to this one, then rolls back", async ({}, info) => {
  test.setTimeout(480_000);
  if (!CURRENT || !PREVIOUS)
    throw new Error("OWNCORD_ARTIFACT_DIR and OWNCORD_PREVIOUS_ARTIFACT_DIR are both required");
  // A target's first release has nothing to update from (Windows ARM64
  // shipped first in the release after v1.2.0-alpha.4). Declared, not hidden.
  test.skip(
    (await readdir(PREVIOUS)).length === 0,
    `the previous release published no ${updaterTarget()} artifact to update from`,
  );
  const version = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8")).version;
  const server = await startTestServer({ tls: true });
  const gateway = await startNativeUpdateServer(server, "", {
    archive: await findAsset(CURRENT, updater),
    signature: await findAsset(CURRENT, `${updater}.sig`),
    version,
    target: updaterTarget(),
  });
  const host = gateway.origin.replace("https://", "");
  const { installation, binary } = await installArtifact(PREVIOUS);
  let app: ArtifactDriver | undefined;
  // Runs `step` (which launches the baseline), relaunching at most twice when
  // the baseline's WebDriver session dies. Each lost attempt's error and
  // driver log (the app's stderr) is attached to the report. Any other error
  // fails at once.
  const baseline = async (label: string, step: () => Promise<void>) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await step();
      } catch (error) {
        if (attempt > 2 || !BASELINE_SESSION_LOST.test(String(error))) throw error;
        await info.attach(`baseline-${label}-lost-${attempt}`, {
          body: `${String(error)}\n\n${app?.log() ?? ""}`,
          contentType: "text/plain",
        });
      }
    }
  };
  const relaunch = async () => {
    await app?.close().catch(() => {});
    // The digest poll sees the new binary as soon as the installer starts
    // writing it, and Windows refuses to start a file still open for writing
    // (EBUSY). Retry until the installer has let go of it.
    const deadline = Date.now() + 60_000;
    for (;;) {
      await killInstalled(binary);
      try {
        app = await launchArtifact(binary, { preserveProfile: true });
        return app;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY" || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  };
  try {
    let previous = "";
    await baseline("launch", async () => {
      await app?.close().catch(() => {});
      await killInstalled(binary);
      app = await launchArtifact(binary);
      await waitFor(app, "#host", "", 60_000);
      previous = await appVersion(app);
      expect(previous).not.toBe(version);
      // Auto-connect, so the relaunched version proves the profile and the
      // stored credential survived the update.
      await app.click("#auto-connect");
    });
    if (!app) throw new Error("the baseline never launched");
    await artifactLogin(app, host, "alice", TEST_PASSWORD);
    const text = `artifact-update-${crypto.randomUUID()}`;
    await app.fill("[data-testid='message-input'] textarea", text);
    await app.press("Enter");
    await waitFor(app, ".msg-text", text);

    // Update: the binary asks for its own target and gets this release.
    const original = await digest(binary);
    await app.click(".update-banner-install", "Update Now");
    await expect
      .poll(() => digest(binary).catch(() => original), { timeout: 180_000, intervals: [2_000] })
      .not.toBe(original);
    expect(gateway.targets()).toContain(updaterTarget());
    expect(new Set(gateway.targets())).toEqual(new Set([updaterTarget()]));
    expect(gateway.downloads()).toBe(1);
    await relaunch();
    await waitFor(app!, "[data-testid='app-layout']", "", 60_000);
    expect(await appVersion(app!)).toBe(version);
    await waitFor(app!, ".msg-text", text);

    // Roll back: reinstall the previous release over the updated one.
    await app!.close().catch(() => {});
    await killInstalled(binary);
    await installArtifact(PREVIOUS, installation);
    // The previous version auto-connects from the profile the update kept
    // (its connect form sits disabled meanwhile): rollback keeps the account.
    await baseline("rollback", async () => {
      await relaunch();
      expect(await appVersion(app!)).toBe(previous);
      await waitFor(app!, "[data-testid='app-layout']", "", 60_000);
    });
    await waitFor(app!, ".msg-text", text);
  } catch (error) {
    if (app)
      await info.attach("artifact-screenshot", {
        body: await app.screenshot().catch(() => Buffer.from("")),
        contentType: "image/png",
      });
    throw error;
  } finally {
    if (app) await info.attach("artifact-driver", { body: app.log(), contentType: "text/plain" });
    await app?.close().catch(() => {});
    await killInstalled(binary);
    await gateway.close();
    await server.close();
  }
});
