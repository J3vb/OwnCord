/**
 * B7-17: drive an INSTALLED release artifact, not a test build.
 *
 * The shipped app has no test hooks: no CDP port, the production identifier
 * (com.owncord.client), the production updater key. So each OS reaches the
 * real UI through a platform-owned automation channel instead of a build flag:
 *
 * - Windows: a WebView2 `AdditionalBrowserArguments` policy for the installed
 *   exe opens the same fixed CDP port the native lane uses, and `native-app.ts`
 *   attaches to it unchanged. Policy, not the WEBVIEW2_* environment override,
 *   because elevated runners ignore the environment (see native-test-config).
 * - Linux: `tauri-driver` fronts WebKitWebDriver, which launches the binary
 *   with TAURI_WEBVIEW_AUTOMATION=true — honoured by release builds.
 *
 * Both sides are wrapped in the small `ArtifactDriver` surface below so one
 * journey spec runs on all four targets. CI only: the Windows policy is a
 * machine setting and the production profile is wiped between launches.
 */
import { expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { startNativeApp } from "./native-app";
import { freePorts, startProcess, stopProcess, waitForHttp } from "./process";

const exec = promisify(execFile);
const WINDOWS_EXE = "owncord-client.exe";
const IDENTIFIER = "com.owncord.client";

export interface ArtifactDriver {
  /** Runs `body` (a function source) in the page with `args`; awaits promises. */
  evaluate<T>(body: string, ...args: unknown[]): Promise<T>;
  /** Real click on the first rendered element matching `css` (and `text`). */
  click(css: string, text?: string): Promise<void>;
  /** Real typing into the first rendered element matching `css`. */
  fill(css: string, value: string): Promise<void>;
  /** A key press on the focused element. */
  press(key: "Escape" | "Enter"): Promise<void>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
  log(): string;
}

/**
 * The pin the app stores for a server certificate: SHA-256 of the DER as
 * lowercase colon-hex (`tofu::fingerprint_hex`).
 */
export function pinOfCertificate(pem: string): string {
  return new X509Certificate(pem).fingerprint256.toLowerCase();
}

/** The pin for the self-signed certificate of a `startTestServer({ tls: true })` server. */
export async function serverPin(serverDirectory: string): Promise<string> {
  return pinOfCertificate(await readFile(join(serverDirectory, "data/cert.pem"), "utf8"));
}

/**
 * Writes the app's `certs.json` into `appDataDir`, pinning each host.
 *
 * This is how the smoke gets past first-use trust without a seam in the shipped
 * binary: pinning a certificate asks a native OS dialog, which neither CDP nor
 * WebDriver can answer and which no release build has a bypass for. A pinned
 * host never asks, and the seeded pin is the certificate the server presents,
 * so the connect still runs the real TLS check against it. Keys are the
 * lowercase `host[:port]` the app's cert store uses.
 */
export async function certPinsFile(
  appDataDir: string,
  pins: Record<string, string>,
): Promise<string> {
  const file = join(appDataDir, "certs.json");
  const keyed = Object.fromEntries(Object.entries(pins).map(([h, fp]) => [h.toLowerCase(), fp]));
  await writeFile(file, JSON.stringify(keyed, null, 2));
  return file;
}

/** The Tauri updater target the installed artifact reports. */
export function updaterTarget(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return process.platform === "win32" ? `windows-${arch}-nsis` : `linux-${arch}-appimage`;
}

/** The one file in `dir` whose name ends with `suffix` (e.g. "-setup.exe"). */
export async function findAsset(dir: string, suffix: string): Promise<string> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(suffix));
  if (names.length !== 1)
    throw new Error(`Expected one *${suffix} in ${dir}, found ${JSON.stringify(names)}`);
  return resolve(dir, names[0]!);
}

/** Installs the artifact the way an owner does and returns what to launch. */
export async function installArtifact(dir: string, installation?: string) {
  if (!process.env.CI) throw new Error("Artifact smoke installs and wipes profiles: CI only");
  const target = installation ?? (await mkdtemp(join(tmpdir(), "owncord-artifact-")));
  if (process.platform === "win32") {
    const installer = await findAsset(dir, "-setup.exe");
    await exec(installer, ["/S", `/D=${target}`], { timeout: 120_000 });
    const exe = join(target, WINDOWS_EXE);
    await readFile(exe);
    return { installation: target, binary: exe };
  }
  // An AppImage is installed by placing it and marking it executable.
  await mkdir(target, { recursive: true });
  const appimage = join(target, "OwnCord.AppImage");
  await copyFile(await findAsset(dir, ".AppImage"), appimage);
  await chmod(appimage, 0o755);
  return { installation: target, binary: appimage };
}

/**
 * The policy's arguments: the debugging port and a fake capture device, and
 * nothing the app ships. WebView2 appends policy arguments to the installed
 * binary's own, and the update smoke launches the PREVIOUS release under this
 * policy too, so a shipped flag copied from this build can clash with the
 * baseline's: Chromium CHECK-crashes on --use-fake-ui-for-media-stream (up to
 * v2.2.0-beta.1) beside --auto-accept-camera-and-microphone-capture, and
 * WebView2 reports that as 0x8000FFFF before the window exists.
 */
export const WINDOWS_CDP_ARGUMENTS =
  "--remote-debugging-port=9222 --use-fake-device-for-media-stream";

async function allowWindowsCdp() {
  await exec("reg", [
    "add",
    "HKLM\\Software\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments",
    "/v",
    WINDOWS_EXE,
    "/t",
    "REG_SZ",
    "/d",
    WINDOWS_CDP_ARGUMENTS,
    "/f",
  ]);
}

export interface LaunchOptions {
  preserveProfile?: boolean;
  /** `host[:port]` -> pin, written to the fresh profile before launch (see `certPinsFile`). */
  pins?: Record<string, string>;
  /** Extra environment for the app process (Linux: inherited through the driver). */
  env?: Record<string, string>;
}

/** Launches the installed artifact and attaches the platform driver. */
export async function launchArtifact(
  binary: string,
  options: LaunchOptions = {},
): Promise<ArtifactDriver> {
  if (!process.env.CI) throw new Error("Artifact smoke changes machine state: CI only");
  if (process.platform === "win32") {
    await allowWindowsCdp();
    const app = await startNativeApp(binary, {
      preserveProfile: options.preserveProfile,
      identifier: IDENTIFIER,
      seedAppData: options.pins && ((dir) => certPinsFile(dir, options.pins!).then(() => {})),
    });
    const page = app.page;
    const first = (css: string, text?: string) =>
      (text ? page.locator(css).filter({ hasText: text }) : page.locator(css))
        .locator("visible=true")
        .first();
    return {
      evaluate: (body, ...args) =>
        page.evaluate(
          ([source, values]) =>
            new Function(`return (${source}).apply(null, arguments[0])`)(values),
          [body, args] as const,
        ),
      click: (css, text) => first(css, text).click(),
      fill: (css, value) => first(css).fill(value),
      press: (key) => page.keyboard.press(key),
      screenshot: () => page.screenshot(),
      close: () => app.close({ preserveProfile: true }),
      log: app.log,
    };
  }
  return launchLinux(binary, options);
}

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
// Resolves the first rendered match, the same rule the Playwright side uses.
const FIND = `(css, text) => [...document.querySelectorAll(css)].find((el) =>
  el.getClientRects().length > 0 && (!text || (el.textContent ?? "").includes(text))) ?? null`;

async function launchLinux(binary: string, options: LaunchOptions): Promise<ArtifactDriver> {
  const home = process.env.HOME ?? "";
  const profiles = [".local/share", ".config", ".cache"].map((root) =>
    join(home, root, IDENTIFIER),
  );
  const clearProfiles = async () => {
    for (const profile of profiles) await rm(profile, { recursive: true, force: true });
  };
  if (!options.preserveProfile) await clearProfiles();
  if (options.pins) {
    // Tauri's app_data_dir on Linux: $XDG_DATA_HOME/<identifier>.
    await mkdir(profiles[0]!, { recursive: true });
    await certPinsFile(profiles[0]!, options.pins);
  }
  const { port, nativePort } = await freePorts("port", "nativePort");
  const driver = startProcess(
    "tauri-driver",
    [
      "--port",
      String(port),
      "--native-port",
      String(nativePort),
      "--native-driver",
      "/usr/bin/WebKitWebDriver",
    ],
    tmpdir(),
    // FUSE is not assumed on runners; the AppImage runtime extracts instead.
    // Its extraction directory is named by the file's hash and deleted by the
    // runtime's parent process when the app exits; killInstalled never matches
    // that parent (APPIMAGE is set only in its child), so a relaunch of the
    // same file could lose its files to the old parent's cleanup. Keep them.
    { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1", NO_CLEANUP: "1", ...options.env },
  );
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const payload = (await response.json()) as { value: any };
    if (!response.ok)
      throw new Error(`WebDriver ${method} ${path}: ${JSON.stringify(payload.value)}`);
    return payload.value;
  };
  let session = "";
  try {
    await waitForHttp(`${base}/status`, driver);
    session = (
      await call("POST", "/session", {
        capabilities: { alwaysMatch: { "tauri:options": { application: binary } } },
      })
    ).sessionId;
  } catch (error) {
    await stopProcess(driver.child);
    throw new Error(`${String(error)}\n${driver.log()}`);
  }
  const evaluate = <T>(body: string, ...args: unknown[]): Promise<T> =>
    call("POST", `/session/${session}/execute/sync`, {
      script: `return (${body}).apply(null, arguments)`,
      args,
    });
  const element = async (css: string, text?: string) => {
    let found: Record<string, string> | null = null;
    await expect
      .poll(async () => (found = await evaluate(FIND, css, text ?? "")), {
        timeout: 30_000,
        message: `no rendered ${css}${text ? ` containing "${text}"` : ""}`,
      })
      .not.toBeNull();
    return found![ELEMENT]!;
  };
  // The app re-renders lists as data arrives, so a found element can be gone
  // by the time WebDriver acts on it. Playwright re-resolves on that; do the same.
  const act = async (css: string, text: string | undefined, run: (id: string) => Promise<void>) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run(await element(css, text));
      } catch (error) {
        if (attempt === 3 || !String(error).includes("stale element reference")) throw error;
      }
    }
  };
  return {
    evaluate,
    click: (css, text) =>
      act(css, text, async (id) => {
        // WebDriver clicks the element's centre as computed now; Playwright (the
        // Windows side) first waits for it to stop moving. Match that: a click
        // during an entry animation (the settings panel scales in) can miss.
        // Looping animations (spinners, speaking rings) never finish; skip them.
        await expect
          .poll(() =>
            evaluate<boolean>(
              `() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity)`,
            ),
          )
          .toBe(true);
        await call("POST", `/session/${session}/element/${id}/click`, {});
      }),
    fill: (css, value) =>
      act(css, undefined, async (id) => {
        await call("POST", `/session/${session}/element/${id}/clear`, {});
        await call("POST", `/session/${session}/element/${id}/value`, { text: value });
      }),
    async press(key) {
      const value = key === "Enter" ? "\uE007" : "\uE00C";
      await call("POST", `/session/${session}/actions`, {
        actions: [
          {
            type: "key",
            id: "keyboard",
            actions: [
              { type: "keyDown", value },
              { type: "keyUp", value },
            ],
          },
        ],
      });
    },
    async screenshot() {
      return Buffer.from(await call("GET", `/session/${session}/screenshot`), "base64");
    },
    async close() {
      try {
        await call("DELETE", `/session/${session}`);
      } catch {
        /* The app may already be gone (an update restarts it). */
      } finally {
        await stopProcess(driver.child);
        await killInstalled(binary);
      }
    },
    log: driver.log,
  };
}

/**
 * Ends every process running the installed binary, including an updater
 * relaunch. Windows kills by image name, trees included: WMI's process query
 * can outlast a 30 s budget on windows-11-arm, and a CI runner has no other
 * owncord-client.exe. taskkill exits non-zero when none is running, which is
 * the state wanted, so its status is not the check.
 */
export async function killInstalled(binary: string) {
  if (process.platform === "win32") {
    await exec("taskkill", ["/im", WINDOWS_EXE, "/t", "/f"], { timeout: 30_000 }).catch(() => {});
    return;
  }
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
    if (environ.split("\0").includes(`APPIMAGE=${binary}`)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
  }
}

/** Waits until `css` (optionally containing `text`) is rendered. */
export async function waitFor(app: ArtifactDriver, css: string, text = "", timeout = 30_000) {
  await expect
    .poll(async () => (await app.evaluate<unknown>(FIND, css, text)) !== null, {
      timeout,
      message: `waiting for ${css}${text ? ` containing "${text}"` : ""}`,
    })
    .toBe(true);
}

export const appVersion = (app: ArtifactDriver) =>
  app.evaluate<string>(`() => window.__TAURI_INTERNALS__.invoke("plugin:app|version")`);

/** The native camera's GStreamer support, as the webview's notice reads it (Linux). */
export const cameraSupport = (app: ArtifactDriver) =>
  app.evaluate<{ available: boolean; missing: string[] }>(
    `() => window.__TAURI_INTERNALS__.invoke("native_voice_camera_support")`,
  );

/**
 * Signs in from the connect page. Launch with `pins` for the host: the shipped
 * app confirms a new pin in a native OS dialog this driver cannot answer, so an
 * unpinned host would hang here. The trust-button branch stays for an older
 * installed version that predates the dialog and pins on the modal alone.
 */
export async function artifactLogin(app: ArtifactDriver, host: string, user: string, pass: string) {
  await waitFor(app, "#host", "", 60_000);
  await app.fill("#host", host);
  await app.fill("#username", user);
  await app.fill("#password", pass);
  await app.click("button.btn-primary[type='submit']");
  const state = async () =>
    app.evaluate<string>(`() =>
      document.querySelector("[data-testid='app-layout']") ? "in" :
      document.querySelector(".modal-overlay.visible .btn-danger") ? "trust" : "wait"`);
  await expect.poll(state, { timeout: 30_000 }).not.toBe("wait");
  if ((await state()) === "trust") {
    await app.click(".modal-overlay.visible .btn-danger", "Trust This Certificate");
    await expect
      .poll(() => app.evaluate<boolean>(`() => !document.querySelector(".modal-overlay.visible")`))
      .toBe(true);
    if ((await state()) !== "in") await app.click("button.btn-primary[type='submit']");
  }
  await waitFor(app, "[data-testid='app-layout']", "", 45_000);
}
