/**
 * B7-17: the owner journey on the INSTALLED release artifact — install, boot,
 * connect, use media and recover an account — against a real server and
 * LiveKit. Same spec on Windows x64/ARM64 and Linux x64/ARM64; only the
 * driver underneath differs (support/artifact-app.ts).
 */
import { test, expect, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  appVersion,
  artifactLogin,
  cameraSupport,
  findAsset,
  installArtifact,
  launchArtifact,
  serverPin,
  waitFor,
  type ArtifactDriver,
} from "../support/artifact-app";
import { startTestServer, TEST_PASSWORD } from "../support/server";
import { nonLoopbackIPv4 } from "../support/process";

const exec = promisify(execFile);
const ARTIFACTS = process.env.OWNCORD_ARTIFACT_DIR ?? "";
const NEW_PASSWORD = "Recovered-E2E-pass-456!";

async function expectedVersion(): Promise<string> {
  return JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8")).version;
}

/**
 * A GStreamer plugin directory holding the host's plugins minus the camera
 * sources, as on a host without gstreamer1.0-plugins-good (or pipewire's).
 */
async function pluginsWithoutCameraSources(dir: string): Promise<string> {
  const host = `/usr/lib/${process.arch === "arm64" ? "aarch64" : "x86_64"}-linux-gnu/gstreamer-1.0`;
  await mkdir(dir, { recursive: true });
  const kept = (await readdir(host)).filter(
    (name) => name.endsWith(".so") && !/^libgst(video4linux2|pipewire)\.so$/.test(name),
  );
  await Promise.all(kept.map((name) => symlink(join(host, name), join(dir, name))));
  return dir;
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
    const emptyPlugins = info.outputPath("gst-empty-plugins");
    await mkdir(emptyPlugins, { recursive: true });
    const app = await launchArtifact(binary, {
      pins: { [host]: await serverPin(server.directory) },
      env:
        process.platform === "linux"
          ? {
              GST_PLUGIN_SYSTEM_PATH_1_0: emptyPlugins,
              GST_PLUGIN_PATH_1_0: emptyPlugins,
              GST_PLUGIN_SCANNER_1_0: "/nonexistent",
              GST_REGISTRY_1_0: info.outputPath("gst-appimage-registry.bin"),
            }
          : undefined,
    });
    await withArtifact(app, info, async () => {
      // Boot: the connect page renders and the binary is this commit's.
      await waitFor(app, "#host", "", 60_000);
      expect(await appVersion(app)).toBe(await expectedVersion());
      // The host GStreamer plugin paths were pointed at an empty directory
      // above (AppRun re-points them at the bundled copy), so camera support
      // here does not depend on the host's plugin path.
      if (process.platform === "linux") {
        expect(await cameraSupport(app)).toEqual({ available: true, missing: [] });
      }

      // Connect: real TLS against the seeded pin, login and the WS ready handshake.
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
      // The package's declared GStreamer dependencies give the camera its pipeline.
      expect(await cameraSupport(app)).toEqual({ available: true, missing: [] });
    });

    // Without the camera plugins the app still boots and names what is
    // missing, which the webview turns into its install notice.
    const bare = await launchArtifact("/usr/bin/owncord-client", {
      env: {
        GST_PLUGIN_SYSTEM_PATH_1_0: await pluginsWithoutCameraSources(
          info.outputPath("gst-plugins"),
        ),
        GST_REGISTRY_1_0: info.outputPath("gst-registry.bin"),
      },
    });
    await withArtifact(bare, info, async () => {
      await waitFor(bare, "#host", "", 60_000);
      expect(await cameraSupport(bare)).toEqual({
        available: false,
        missing: ["v4l2src", "pipewiresrc"],
      });
    });
  } finally {
    await exec("sudo", ["apt-get", "remove", "-y", name], { timeout: 60_000 }).catch(() => {});
  }
});

/**
 * RT-11: the Linux artifact joins voice against a server that is NOT on
 * loopback, which is the path RT-1 broke — the Rust LiveKit SDK sends its
 * join token only as an `Authorization: Bearer` header, and the client
 * tunnels a remote server's LiveKit through the server's `/livekit` proxy.
 * On loopback the client takes the `direct_url` shortcut and never exercises
 * the tunnel (proxy start, TLS pin, WS proxy, the server's `/livekit` reverse
 * proxy), so a regression there is invisible. The journey dials the server by
 * the runner's own non-loopback IPv4 and asserts the native voice join
 * succeeded over the `tunnel` path, not `direct`. The tunnel moves the bearer
 * token into the query before the server sees it, so the server's
 * Authorization forwarding keeps its own unit coverage.
 */
test("installed Linux artifact joins voice by a non-loopback server address", async ({}, info) => {
  test.skip(
    process.platform !== "linux",
    "RT-11 guards the Linux native voice join, whose SDK sends a bearer-only header",
  );
  // Resolve the address before starting the server, so a runner with only
  // loopback fails without leaking a server and its LiveKit child.
  const host = nonLoopbackIPv4();
  if (host === null) throw new Error("RT-11: the runner has no non-loopback IPv4 to dial");
  test.setTimeout(300_000);
  const server = await startTestServer({ tls: true, livekit: true });
  const remoteHost = `${host}:${server.port}`;
  const { installation, binary } = await installArtifact(ARTIFACTS);
  try {
    const app = await launchArtifact(binary, {
      pins: { [remoteHost]: await serverPin(server.directory) },
    });
    await withArtifact(app, info, async () => {
      await waitFor(app, "#host", "", 60_000);
      // Connect to the LAN address: real TLS against the seeded pin over the tunnel.
      await artifactLogin(app, remoteHost, "alice", TEST_PASSWORD);
      await waitFor(app, ".channel-item");

      await app.click(".channel-item.voice", "voice-one");
      await waitFor(app, ".voice-widget.visible", "Voice Connected", 60_000);

      // The join must have gone through the local TLS tunnel (serverHost is
      // non-loopback), which is exactly the path RT-1 fixed. `direct` here
      // would mean the test dialed loopback and proves nothing. "Voice
      // Connected" shows before the join is recorded, so wait for the record.
      await expect
        .poll(
          () =>
            app.evaluate<{ urlKind: string; succeeded: boolean } | null>(`() => {
              const voiceJoin = window.__owncord?.lkDebug?.().voiceJoin;
              const last = voiceJoin?.lastJoins?.[0];
              if (voiceJoin?.active !== null || last === undefined) return null;
              return { urlKind: last.urlKind, succeeded: last.succeeded };
            }`),
          { timeout: 30_000 },
        )
        .toEqual({ urlKind: "tunnel", succeeded: true });

      await app.click(".voice-widget.visible button[aria-label='Disconnect']");
      await expect
        .poll(() => app.evaluate<boolean>(`() => !document.querySelector(".voice-widget.visible")`))
        .toBe(true);
    });
  } finally {
    await server.close();
    await rm(installation, { recursive: true, force: true });
  }
});
