/**
 * Native E2E: the desktop-only surface a browser build cannot reach — window
 * geometry restore and its off-screen guard (lib/window-state.ts), the tray's
 * Status submenu events (main.ts → platform/desktop/trayStatus.ts), the
 * reload/DevTools keyboard handling in main.ts, external links (main.ts routes
 * them, backed by tauri-plugin-opener's injected click handler), and
 * push-to-talk driven by the real GetAsyncKeyState poller
 * (platform/desktop/pushToTalkService.ts).
 *
 * Keys are injected at the OS level (user32 keybd_event through PowerShell),
 * not through CDP: CDP input never reaches GetAsyncKeyState, and it bypasses
 * the WebView2 accelerator path that turns F5 into a reload.
 */

import { test, expect } from "../native-fixture-persistent";
import { startNativeApp, withNativeArtifacts, type NativeApp } from "../support/native-app";
import { ensureLoggedIn, openSettings, waitForMessages } from "./helpers";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Frame, Page } from "@playwright/test";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// OS input
// ---------------------------------------------------------------------------

const VK = {
  SHIFT: 0x10,
  CONTROL: 0x11,
  I: 0x49,
  Q: 0x51,
  R: 0x52,
  F5: 0x74,
  F12: 0x7b,
  // A key nothing else on the runner presses, and one PTT capture allows.
  F16: 0x7f,
  F24: 0x87,
} as const;

/** pwsh first: a cold powershell.exe start took up to 30s on loaded runners
 *  (see packaged-update.spec.ts). Windows PowerShell is the local fallback. */
async function powershell(script: string): Promise<string> {
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  try {
    return (await exec("pwsh", args, { timeout: 60_000 })).stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return (await exec("powershell", args, { timeout: 60_000 })).stdout;
  }
}

const USER32 = `Add-Type -Namespace OwnCordE2E -Name User32 -MemberDefinition '
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hwnd);
';`;

type KeyStep = readonly [vk: number, edge: "down" | "up"];

function keyEvents(steps: readonly KeyStep[]): string {
  return steps
    .map(
      ([vk, edge]) =>
        `[OwnCordE2E.User32]::keybd_event(${vk}, [OwnCordE2E.User32]::MapVirtualKey(${vk}, 0), ${edge === "up" ? 2 : 0}, [System.UIntPtr]::Zero); Start-Sleep -Milliseconds 40`,
    )
    .join("\n");
}

/** Press each chord in order: modifiers down, key down/up, modifiers up. */
function chords(...keys: (readonly number[])[]): KeyStep[] {
  return keys.flatMap((chord) => [
    ...chord.map((vk): KeyStep => [vk, "down"]),
    ...[...chord].reverse().map((vk): KeyStep => [vk, "up"]),
  ]);
}

async function sendKeys(steps: readonly KeyStep[]): Promise<void> {
  await powershell(`${USER32}\n${keyEvents(steps)}`);
}

/** Make the app the foreground window, so injected keys reach its webview.
 *  Windows only lets the process that produced the last input event move the
 *  foreground, so tap a key first. Not the usual Alt: a bare Alt tap that
 *  lands on the app window enters its system-menu loop and freezes WebView2;
 *  nothing in the app or the webview handles F24. */
async function bringToForeground(app: NativeApp, page: Page): Promise<void> {
  await powershell(`${USER32}
$h = (Get-Process -Id ${app.process.pid}).MainWindowHandle
if ($h -eq [System.IntPtr]::Zero) { throw 'OwnCord has no main window' }
${keyEvents(chords([VK.F24]))}
if (-not [OwnCordE2E.User32]::SetForegroundWindow($h)) { throw 'SetForegroundWindow refused' }`);
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
}

// ---------------------------------------------------------------------------
// Tauri IPC
// ---------------------------------------------------------------------------

function invoke<T>(page: Page, cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(([c, a]) => (window as any).__TAURI_INTERNALS__.invoke(c, a), [
    cmd,
    args,
  ] as const);
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function windowRect(page: Page): Promise<Rect> {
  const label = { label: "main" };
  const pos = await invoke<{ x: number; y: number }>(page, "plugin:window|outer_position", label);
  const size = await invoke<{ width: number; height: number }>(
    page,
    "plugin:window|outer_size",
    label,
  );
  return { ...pos, ...size };
}

async function moveWindowAndSaveState(page: Page, x: number, y: number): Promise<Rect> {
  await invoke(page, "plugin:window|set_position", {
    label: "main",
    value: { Physical: { x, y } },
  });
  await expect.poll(async () => (await windowRect(page)).x).toBe(x);
  // What the window-state plugin otherwise writes on a graceful exit; the
  // harness terminates the process, so persist explicitly.
  await invoke(page, "plugin:window-state|save_window_state", {});
  return windowRect(page);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// First in the file: it launches its own app instances, so it must run before
// any test starts this worker's shared app (both would claim CDP port 9222).
// eslint-disable-next-line no-empty-pattern -- no fixtures: this test owns its app instances
test("window geometry is restored on relaunch and an unreachable restore is re-centered", async ({}, testInfo) => {
  let app: NativeApp | undefined = await startNativeApp();
  try {
    const relaunch = async () => {
      await app!.close({ preserveProfile: true });
      app = undefined;
      app = await startNativeApp(undefined, { preserveProfile: true });
    };

    let monitor!: { position: { x: number; y: number }; size: { width: number; height: number } };
    let saved!: Rect;
    await withNativeArtifacts(
      app,
      async () => {
        const page = app!.page;
        monitor = await invoke(page, "plugin:window|current_monitor");
        expect(await invoke(page, "plugin:window|is_maximized", { label: "main" })).toBe(false);
        await invoke(page, "plugin:window|set_size", {
          label: "main",
          value: { Logical: { width: 960, height: 560 } },
        });
        saved = await moveWindowAndSaveState(
          page,
          monitor.position.x + 16,
          monitor.position.y + 16,
        );
      },
      testInfo,
    );

    // A reachable position is restored as saved and left alone by the guard.
    await relaunch();
    await withNativeArtifacts(
      app!,
      async () => {
        const page = app!.page;
        await expect.poll(() => windowRect(page)).toEqual(saved);
        // Top-left corner 50px inside the monitor's right edge: the plugin
        // restores it (a corner is on a monitor), but 50px is too little to
        // grab, so lib/window-state.ts must re-center it.
        saved = await moveWindowAndSaveState(
          page,
          monitor.position.x + monitor.size.width - 50,
          monitor.position.y + 16,
        );
      },
      testInfo,
    );

    await relaunch();
    await withNativeArtifacts(
      app!,
      async () => {
        const page = app!.page;
        // The guard runs once at startup, after the plugin's restore.
        await expect
          .poll(async () => {
            const r = await windowRect(page);
            const overlap =
              Math.min(r.x + r.width, monitor.position.x + monitor.size.width) -
              Math.max(r.x, monitor.position.x);
            return overlap >= 100 && r.y >= monitor.position.y - 8;
          })
          .toBe(true);
        const restored = await windowRect(page);
        expect(restored.x).not.toBe(saved.x);
        expect({ width: restored.width, height: restored.height }).toEqual({
          width: saved.width,
          height: saved.height,
        });
      },
      testInfo,
    );
  } finally {
    await app?.close();
  }
});

test("tray Status picks set the saved and server-side presence", async ({
  nativePage: page,
  nativeServer,
}) => {
  await ensureLoggedIn(page);
  const shown = page.locator("[data-testid='user-bar'] .ub-status");
  const stored = async () => {
    const users: { username: string; status: string }[] = await nativeServer.api(
      "/admin/api/users",
      undefined,
      nativeServer.owner!.token,
    );
    return users.find((u) => u.username === "alice")?.status;
  };
  // The tray menu is native OS UI that CDP cannot click; this is the event
  // src-tauri/src/tray.rs emits for each Status item.
  const pick = (status: string) =>
    invoke(page, "plugin:event|emit", { event: "status-change", payload: status });

  // "offline" is the tray's legacy spelling of invisible.
  for (const [item, text, server] of [
    ["dnd", "Do Not Disturb", "dnd"],
    ["offline", "Invisible", "invisible"],
    ["online", "Online", "online"],
  ] as const) {
    await pick(item);
    await expect(shown).toHaveText(text);
    // The server accepts one presence update per 10s; later picks queue.
    await expect.poll(stored, { timeout: 25_000 }).toBe(server);
  }
});

test("F5 and Ctrl+R never reload the app and a release build opens no DevTools", async ({
  nativeApp,
  nativePage: page,
}) => {
  await ensureLoggedIn(page);
  const textarea = page.getByTestId("msg-textarea");
  await textarea.fill("");
  let navigations = 0;
  const onNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) navigations++;
  };
  page.on("framenavigated", onNavigated);
  await page.evaluate(() => ((window as any).__nativeExtraDocument = true));

  await bringToForeground(nativeApp, page);
  await textarea.focus();
  await sendKeys(
    chords(
      [VK.F5],
      [VK.CONTROL, VK.R],
      [VK.CONTROL, VK.SHIFT, VK.R],
      [VK.F12],
      [VK.CONTROL, VK.SHIFT, VK.I],
      // Control: a plain key sent the same way must land in the composer, so
      // the shortcuts above provably reached the webview.
      [VK.Q],
    ),
  );
  await expect(textarea).toHaveValue("q");
  // A reload or DevTools window would be started by the browser process after
  // the renderer declines the key; give it time to appear before asserting
  // that it did not.
  await delay(2_000);
  page.off("framenavigated", onNavigated);
  expect(navigations).toBe(0);
  expect(await page.evaluate(() => (window as any).__nativeExtraDocument)).toBe(true);
  const devToolsWindows = await powershell(
    "Get-Process | Where-Object { $_.MainWindowTitle -like 'DevTools*' } | ForEach-Object { $_.MainWindowTitle }",
  );
  expect(devToolsWindows.trim()).toBe("");
  await textarea.fill("");

  // Neither the IPC command nor the Advanced tab's button exists in release.
  await expect(invoke(page, "open_devtools")).rejects.toThrow(/open_devtools/);
  await openSettings(page);
  await page.locator(".settings-sidebar button.settings-nav-item", { hasText: "Advanced" }).click();
  const pane = page.locator(".settings-content .settings-pane.active");
  await expect(pane.getByText("Storage & Cache")).toBeVisible();
  await expect(pane.getByRole("button", { name: "Open DevTools" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("a message link opens in the system browser, not the webview", async ({
  nativePage: page,
  nativeContext,
}) => {
  await ensureLoggedIn(page);
  await waitForMessages(page);
  const hits: string[] = [];
  const target = createServer((req, res) => {
    hits.push(`${req.url} ${req.headers["user-agent"]}`);
    res.end("<title>OwnCord external link</title>");
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const path = `/native-extra-${Date.now()}`;
  const url = `http://127.0.0.1:${(target.address() as AddressInfo).port}${path}`;
  // Processes launched with this test's unique URL on their command line,
  // other than this PowerShell itself.
  const launched = (action: string) =>
    powershell(
      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${path}*' } | ForEach-Object { ${action} }`,
    );
  try {
    const textarea = page.getByTestId("msg-textarea");
    await textarea.fill(`external ${url}`);
    await textarea.press("Enter");
    const link = page.locator(`a.msg-link[href="${url}"]`);
    await expect(link).toHaveAttribute("target", "_blank");
    const before = page.url();
    await link.click();
    // Loopback is outside the link-preview fetcher's allowed ranges, so a
    // browser user agent on this path is a browser loading the link.
    await expect
      .poll(() => hits.filter((hit) => hit.startsWith(path) && hit.includes("Mozilla")), {
        timeout: 30_000,
      })
      .not.toHaveLength(0);
    // The fetch alone does not say which browser made it; the shell hand-off
    // starts a separate browser process with the URL as its argument.
    const browsers = (await launched("$_.Name")).split(/\s+/).filter(Boolean);
    expect(browsers.filter((name) => name.toLowerCase() !== "msedgewebview2.exe")).not.toEqual([]);
    expect(page.url()).toBe(before);
    expect(nativeContext.pages()).toHaveLength(1);
  } finally {
    target.closeAllConnections();
    target.close();
    // Close only the browser this test opened: the process whose command line
    // carries this test's unique URL. Best effort — it must not mask a failure.
    await launched("taskkill /pid $_.ProcessId /t /f | Out-Null").catch(() => {});
  }
});

test("push-to-talk binds a key through capture and gates the mic on its real key state", async ({
  nativePage: page,
}) => {
  await ensureLoggedIn(page);
  const keybind = page.getByRole("button", { name: "Push to Talk keybind — click to capture" });
  const openKeybinds = async () => {
    await openSettings(page);
    await page
      .locator(".settings-sidebar button.settings-nav-item", { hasText: "Keybinds" })
      .click();
    await expect(keybind).toBeVisible();
  };
  let held = false;
  try {
    await openKeybinds();
    await expect(keybind).toHaveText("Not set");
    await keybind.click();
    await expect(keybind).toHaveText("Press a supported key...");
    // Capture polls the global key state; it returns once the key is released.
    await sendKeys(chords([VK.F16]));
    await expect(keybind).toHaveText("F16");
    await page.keyboard.press("Escape");

    await page.locator(".channel-item.voice", { hasText: "voice-one" }).click();
    const widget = page.locator(".voice-widget.visible");
    // Same budget as voice-controls.spec.ts: three connect attempts.
    await expect(widget).toContainText("Voice Connected", { timeout: 60_000 });
    const mute = widget.getByRole("button", { name: "Mute", exact: true });

    // Each edge is a separate PowerShell start (about a second), which also
    // keeps these mute changes inside the server's two-per-second budget.
    const hold = async () => {
      held = true;
      await sendKeys([[VK.F16, "down"]]);
    };
    const release = async () => {
      await sendKeys([[VK.F16, "up"]]);
      held = false;
    };
    await hold();
    await release();
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    await hold();
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    await release();
    await expect(mute).toHaveAttribute("aria-pressed", "true");

    // Clearing the binding lifts the mute that PTT itself applied.
    await openKeybinds();
    await page
      .locator(".settings-content .settings-pane.active")
      .getByRole("button", { name: "Clear", exact: true })
      .click();
    await expect(keybind).toHaveText("Not set");
    await page.keyboard.press("Escape");
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    await widget.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(widget).toBeHidden();
  } finally {
    if (held) await sendKeys([[VK.F16, "up"]]);
  }
});
