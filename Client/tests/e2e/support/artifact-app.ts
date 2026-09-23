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
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { startNativeApp } from "./native-app";
import { freePort, startProcess, stopProcess, waitForHttp } from "./process";

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

async function allowWindowsCdp() {
  // Keep the shipped arguments (media auto-grant) whether WebView2 appends
  // or replaces; add the debugging port and a fake capture device.
  const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  const args = `${config.app.windows[0].additionalBrowserArgs} --remote-debugging-port=9222 --use-fake-device-for-media-stream`;
  await exec("reg", [
    "add",
    "HKLM\\Software\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments",
    "/v",
    WINDOWS_EXE,
    "/t",
    "REG_SZ",
    "/d",
    args,
    "/f",
  ]);
}

/** Launches the installed artifact and attaches the platform driver. */
export async function launchArtifact(
  binary: string,
  options: { preserveProfile?: boolean } = {},
): Promise<ArtifactDriver> {
  if (!process.env.CI) throw new Error("Artifact smoke changes machine state: CI only");
  if (process.platform === "win32") {
    await allowWindowsCdp();
    const app = await startNativeApp(binary, { ...options, identifier: IDENTIFIER });
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

async function launchLinux(
  binary: string,
  options: { preserveProfile?: boolean },
): Promise<ArtifactDriver> {
  const home = process.env.HOME ?? "";
  const profiles = [".local/share", ".config", ".cache"].map((root) =>
    join(home, root, IDENTIFIER),
  );
  const clearProfiles = async () => {
    for (const profile of profiles) await rm(profile, { recursive: true, force: true });
  };
  if (!options.preserveProfile) await clearProfiles();
  const port = await freePort();
  const nativePort = await freePort();
  const driver = startProcess(
    process.env.OWNCORD_TAURI_DRIVER ?? "tauri-driver",
    [
      "--port",
      String(port),
      "--native-port",
      String(nativePort),
      "--native-driver",
      process.env.OWNCORD_WEBKIT_DRIVER ?? "/usr/bin/WebKitWebDriver",
    ],
    tmpdir(),
    // FUSE is not assumed on runners; the AppImage runtime extracts instead.
    { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
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
  return {
    evaluate,
    async click(css, text) {
      await call("POST", `/session/${session}/element/${await element(css, text)}/click`, {});
    },
    async fill(css, value) {
      const id = await element(css);
      await call("POST", `/session/${session}/element/${id}/clear`, {});
      await call("POST", `/session/${session}/element/${id}/value`, { text: value });
    },
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

/**
 * Signs in from the connect page. Trusts the first-use certificate when the
 * app asks — every version of the flow shows the same trust button, but not
 * every version asks before the first submit.
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
