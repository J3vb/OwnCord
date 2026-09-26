/**
 * B7-17: the owner journey on the INSTALLED release artifact — install, boot,
 * connect, use media and recover an account — against a real server and
 * LiveKit. Same spec on Windows x64/ARM64 and Linux x64/ARM64; only the
 * driver underneath differs (support/artifact-app.ts).
 */
import { test, expect, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  appVersion,
  artifactLogin,
  findAsset,
  installArtifact,
  launchArtifact,
  waitFor,
  type ArtifactDriver,
} from "../support/artifact-app";
import { startTestServer, TEST_PASSWORD } from "../support/server";

const exec = promisify(execFile);
const ARTIFACTS = process.env.OWNCORD_ARTIFACT_DIR ?? "";
const NEW_PASSWORD = "Recovered-E2E-pass-456!";

async function expectedVersion(): Promise<string> {
  return JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8")).version;
}

/** Diagnostics first, then teardown; never mask the test's own failure. */
async function withArtifact(app: ArtifactDriver, info: TestInfo, body: () => Promise<void>) {
  try {
    await body();
  } catch (error) {
    await info.attach("artifact-screenshot", {
      body: await app.screenshot().catch(() => Buffer.from("")),
      contentType: "image/png",
    });
    // WebDriver exposes no console, so the rendered text is the next best view.
    const dom = info.outputPath("artifact-dom.txt");
    await writeFile(dom, await app.evaluate<string>(`() => document.body.innerText`).catch(String));
    await info.attach("artifact-dom", { path: dom, contentType: "text/plain" });
    throw error;
  } finally {
    const log = info.outputPath("artifact-driver.log");
    await writeFile(log, app.log());
    await info.attach("artifact-driver", { path: log, contentType: "text/plain" });
    await app.close();
  }
}

test.beforeAll(() => {
  if (!ARTIFACTS) throw new Error("OWNCORD_ARTIFACT_DIR must name the downloaded release assets");
});

test("installed artifact boots, connects, joins voice and recovers an account", async ({}, info) => {
  test.setTimeout(300_000);
  const server = await startTestServer({ tls: true, livekit: true });
  const host = server.origin.replace("https://", "");
  const { installation, binary } = await installArtifact(ARTIFACTS);
  try {
    const app = await launchArtifact(binary);
    await withArtifact(app, info, async () => {
      // Boot: the connect page renders and the binary is this commit's.
      await waitFor(app, "#host", "", 60_000);
      expect(await appVersion(app)).toBe(await expectedVersion());

      // Connect: real TLS first-use trust, login and the WS ready handshake.
      await artifactLogin(app, host, "alice", TEST_PASSWORD);
      await waitFor(app, ".channel-item");

      // Media: a real LiveKit join with working controls (the native lane's bar).
      await app.click(".channel-item.voice", "voice-one");
      await waitFor(app, ".voice-widget.visible", "Voice Connected", 60_000);
      const pressed = () =>
        app.evaluate<string | null>(
          `() => document.querySelector(".voice-widget.visible button[aria-label='Mute']")?.getAttribute("aria-pressed") ?? null`,
        );
      expect(await pressed()).toBe("false");
      await app.click(".voice-widget.visible button[aria-label='Mute']");
      await expect.poll(pressed).toBe("true");
      await app.click(".voice-widget.visible button[aria-label='Disconnect']");
      await expect
        .poll(() => app.evaluate<boolean>(`() => !document.querySelector(".voice-widget.visible")`))
        .toBe(true);

      // Recover: issue a kit in settings, sign out, recover with it.
      await app.click("button[aria-label='Settings']");
      await app.click("[data-testid='recovery-kit-section'] [data-testid='recovery-kit-btn']");
      await app.fill("[data-testid='recovery-kit-password']", TEST_PASSWORD);
      await app.click("[data-testid='recovery-kit-submit']");
      await waitFor(app, "[data-testid='recovery-kit-secret']");
      const secret = await app.evaluate<string>(
        `() => document.querySelector("[data-testid='recovery-kit-secret']").textContent.trim()`,
      );
      expect(secret).toMatch(/\S{16,}/);
      await app.click("[data-testid='shown-once-done']");
      await app.click(".settings-nav-item.danger", "Log Out");
      await waitFor(app, "#host");
      await app.fill("#host", host);
      await app.click("[data-testid='recover-account-link']");
      await waitFor(app, "[data-testid='recover-overlay']");
      await app.fill("#recover-username", "alice");
      await app.fill("#recover-secret", secret);
      await app.fill("#recover-password", NEW_PASSWORD);
      await app.click("[data-testid='recover-submit']");
      await waitFor(app, "[data-testid='app-layout']", "", 45_000);
      await waitFor(app, ".channel-item");
    });
    // The recovered account is really usable: the new password signs in, the
    // old one no longer does, and the spent kit reads as used.
    const session = await server.api("/api/v1/auth/login", {
      username: "alice",
      password: NEW_PASSWORD,
    });
    await expect(
      server.api("/api/v1/auth/login", { username: "alice", password: TEST_PASSWORD }),
    ).rejects.toThrow(/401|403/);
    const kit = await server.api("/api/v1/users/me/recovery-kit", undefined, session.token);
    expect(kit.used_at).toBeTruthy();
  } finally {
    await server.close();
    if (process.platform !== "win32") await rm(installation, { recursive: true, force: true });
  }
});

test("the .deb package installs through apt and boots", async ({}, info) => {
  test.skip(process.platform !== "linux", "Linux ships a .deb beside the AppImage");
  test.setTimeout(180_000);
  const deb = await findAsset(ARTIFACTS, ".deb");
  const name = (await exec("dpkg-deb", ["-f", deb, "Package"])).stdout.trim();
  // apt, not dpkg -x: the package's declared dependencies must resolve.
  await exec("sudo", ["apt-get", "install", "-y", "--no-install-recommends", deb], {
    timeout: 150_000,
    env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
  });
  try {
    const app = await launchArtifact("/usr/bin/owncord-client");
    await withArtifact(app, info, async () => {
      await waitFor(app, "#host", "", 60_000);
      expect(await appVersion(app)).toBe(await expectedVersion());
    });
  } finally {
    await exec("sudo", ["apt-get", "remove", "-y", name], { timeout: 60_000 }).catch(() => {});
  }
});
