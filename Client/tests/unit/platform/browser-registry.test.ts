// WP 6.13b: the browser platform registry is a complete, inert `Platform`. It
// is assigned to the contract type with no cast, it imports nothing native, and
// each member refuses or does nothing exactly as its contract allows.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../../../src/platform/contracts";
import { browser, desktop } from "../../../src/platform/browser";

const browserDir = path.resolve(__dirname, "../../../src/platform/browser");

describe("browser platform registry", () => {
  it("satisfies Platform with no cast", () => {
    const platform: Platform = browser;
    expect(desktop).toBe(browser);
    expect(Object.keys(platform).sort()).toEqual(
      [
        "appAudio",
        "appMetadata",
        "appProcess",
        "autostart",
        "credentials",
        "deepLinks",
        "devTools",
        "externalContent",
        "fileSaver",
        "gameDetector",
        "globalShortcuts",
        "http",
        "identity",
        "logFiles",
        "mediaDetector",
        "nativeProxies",
        "nativeVoice",
        "notifier",
        "pendingMessages",
        "pushToTalk",
        "serverScope",
        "settings",
        "socket",
        "systemIdle",
        "trayStatus",
        "updater",
        "urlOpener",
        "window",
        "windowPrefs",
      ].sort(),
    );
  });

  it("imports nothing from @tauri-apps or platform/desktop", () => {
    const files = readdirSync(browserDir, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.tsx?$/.test(f),
    );
    expect(files).toContain("index.ts");
    for (const file of files) {
      const text = readFileSync(path.join(browserDir, file), "utf8");
      expect(text, file).not.toMatch(/@tauri-apps/);
      expect(text, file).not.toMatch(/platform\/desktop|\.\.\/desktop/);
      expect(text, file).not.toMatch(/\bas\s+(unknown|any|Platform)\b/);
    }
  });

  it("binds the server scope to the page's own host", () => {
    expect(browser.serverScope).toEqual({ fixedHost: location.host });
  });

  it("refuses or does nothing on every capability", async () => {
    const b = browser;
    // jsdom's page is not a secure context, so transport, storage and
    // identity are inert here too (6.13c).
    expect(globalThis.isSecureContext).not.toBe(true);
    // Storage and identity: nothing stored, nothing found.
    expect(await b.credentials.save("h", "u", "t")).toBe(false);
    expect(await b.credentials.load("h")).toBeNull();
    expect(await b.credentials.delete("h")).toBe(false);
    expect(await b.credentials.loginWithSavedPassword("h", "u")).toBeNull();
    expect(await b.identity.saveKey("h", "k")).toBe(false);
    expect(await b.identity.loadKey("h")).toBeNull();
    expect(await b.identity.deleteKey("h")).toBe(false);
    expect(await b.identity.storePin("h", "1", "p")).toBe("no-store");
    expect(await b.identity.getPin("h", "1")).toEqual({ status: "unavailable" });
    expect(await b.settings.load()).toBeNull();
    await expect(b.settings.save({ schemaVersion: 1, profiles: [] })).resolves.toBeUndefined();
    const owner = { host: "h", userId: 1 };
    expect(await b.pendingMessages.load(owner)).toBeNull();
    await expect(b.pendingMessages.save(owner, "x")).resolves.toBeUndefined();
    await expect(b.pendingMessages.delete(owner)).resolves.toBeUndefined();
    expect(await b.windowPrefs.load()).toBeNull();
    expect(await b.windowPrefs.set("minimizeToTray", true)).toBe(false);

    // Transport: refuses.
    await expect(b.http.fetch("https://example.invalid/")).rejects.toThrow();
    const unsubscribeProgress = b.http.onUploadProgress(() => undefined);
    expect(() => unsubscribeProgress()).not.toThrow();
    const conn = b.socket.create();
    await expect(conn.connect({ url: "wss://x", token: "t" })).rejects.toThrow();
    await expect(conn.send("x")).rejects.toThrow();
    await expect(conn.disconnect()).resolves.toBeUndefined();
    await expect(conn.acceptCertificate("h", "f")).resolves.toBeUndefined();
    await expect(conn.startCertListener()).resolves.toBeUndefined();
    for (const subscribe of [
      conn.onStateChange,
      conn.onMessage,
      conn.onCertFirstUse,
      conn.onCertMismatch,
    ]) {
      expect(() => subscribe(() => undefined)()).not.toThrow();
    }
    await expect(b.nativeProxies.ensureHttpProxy("h")).rejects.toThrow();
    expect(() => b.nativeProxies.setLiveKitServerHost("h")).not.toThrow();
    expect(await b.nativeProxies.resolveLiveKitUrl("/p", "wss://direct")).toBe("wss://direct");
    await expect(b.nativeProxies.resolveLiveKitUrl("/p")).rejects.toThrow();
    expect(() => b.nativeProxies.stopLiveKitProxy()).not.toThrow();

    // Logs, files, window, process.
    expect(await b.logFiles.init()).toBeTypeOf("function");
    await expect(b.logFiles.flush()).resolves.toBeUndefined();
    await expect(b.logFiles.clearPending()).resolves.toBeUndefined();
    expect(b.logFiles.getDir()).toBeNull();
    await expect(b.logFiles.clearAll()).resolves.toBeUndefined();
    expect(await b.logFiles.readAll()).toEqual([]);
    expect(await b.logFiles.readNative()).toEqual([]);
    expect(await b.logFiles.openFolder()).toMatchObject({ ok: false });
    // A save is a browser download (6.13d): no dialog, so the name stands in.
    expect(await b.fileSaver.pickSaveLocation("a.txt")).toBe("a.txt");
    expect(await b.window.isMaximized()).toBe(false);
    expect(await b.window.availableMonitors()).toEqual([]);
    expect(await b.window.outerPosition()).toEqual({ x: 0, y: 0 });
    expect(await b.window.outerSize()).toEqual({ width: 0, height: 0 });
    await expect(b.window.center()).resolves.toBeUndefined();
    await expect(b.window.setFullscreen(true)).resolves.toBeUndefined();
    expect(await b.window.setZoom(1)).toBe(false);
    await expect(b.appProcess.reportReady()).resolves.toBeUndefined();
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    try {
      // A page relaunches by reloading itself.
      await expect(b.appProcess.relaunch()).resolves.toBeUndefined();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
    await expect(b.devTools.open()).resolves.toBeUndefined();
    await expect(b.appMetadata.getVersion()).rejects.toThrow();
    // The URL opener opens a new tab (opener.browser.test.ts); with no tab
    // to give, it rejects.
    const open = vi.fn(() => null);
    vi.stubGlobal("open", open);
    try {
      await expect(b.urlOpener.open("https://example.invalid/")).rejects.toThrow();
      expect(open).toHaveBeenCalledWith("https://example.invalid/", "_blank");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await b.systemIdle.idleMs()).toBeNull();
    // The web build scans nothing: no game, and the setting stays hidden.
    expect(b.gameDetector.available).toBe(false);
    expect(await b.gameDetector.detect()).toBeNull();
    // Nor does it read a song (WP 8.10).
    expect(b.mediaDetector.available).toBe(false);
    expect(await b.mediaDetector.detect({ hidden: [] })).toEqual({ state: "none" });
    expect(() => b.trayStatus.onStatusChange(() => undefined)()).not.toThrow();

    // The four contracts a Settings control sits on say they are unavailable.
    expect(b.updater.available).toBe(false);
    expect(b.autostart.available).toBe(false);
    expect(b.window.available).toBe(false);
    expect(b.devTools.available).toBe(false);

    // Updates, shortcuts, links.
    expect(await b.updater.checkForUpdate("https://s")).toMatchObject({ available: false });
    await expect(b.updater.downloadAndInstallUpdate("https://s")).rejects.toThrow();
    expect(() => b.updater.subscribeToInstall(() => undefined)()).not.toThrow();
    expect(await b.autostart.isEnabled()).toBe(false);
    await expect(b.autostart.enable()).rejects.toThrow();
    await expect(b.autostart.disable()).resolves.toBeUndefined();
    await expect(b.pushToTalk.init()).resolves.toBeUndefined();
    await expect(b.pushToTalk.stop()).resolves.toBeUndefined();
    await expect(b.pushToTalk.updateKey(1)).resolves.toBeUndefined();
    await expect(b.pushToTalk.captureKeyPress()).rejects.toThrow();
    expect(await b.pushToTalk.supported()).toBe(false);
    await expect(b.globalShortcuts.start()).resolves.toBeUndefined();
    expect(await b.globalShortcuts.supported()).toBe(false);
    await expect(b.globalShortcuts.setKeys({ muteVk: 1, deafenVk: 2 })).resolves.toBeUndefined();
    expect((await b.globalShortcuts.status()).backend).toBe("none");
    await expect(
      b.globalShortcuts.bindPortal({ pttVk: 1, muteVk: 2, deafenVk: 3 }),
    ).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(b.globalShortcuts.configurePortal()).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(() => b.globalShortcuts.onStatusChange(() => undefined)()).not.toThrow();
    expect(() => b.globalShortcuts.onShortcut(() => undefined)()).not.toThrow();
    await expect(b.deepLinks.init(() => undefined)).resolves.toBeUndefined();

    // Notifications.
    expect(b.notifier.readsOsPermission).toBe(false);
    expect(await b.notifier.permissionGranted()).toBe(false);
    expect(await b.notifier.requestPermission()).toBe(false);
    const target = { host: "h", channelId: 1 };
    await expect(b.notifier.show("t", "b")).resolves.toBeUndefined();
    await expect(b.notifier.showMessage("t", "b", target)).resolves.toBeUndefined();
    await expect(b.notifier.showCall("t", "b", target)).resolves.toBeUndefined();
    await expect(b.notifier.clearCall(1)).resolves.toBeUndefined();
    expect(() => b.notifier.onMessageActivated(() => undefined)()).not.toThrow();
    await expect(b.notifier.flashTaskbar()).resolves.toBeUndefined();
    await expect(b.notifier.requestAttention()).resolves.toBeUndefined();
    await expect(b.notifier.setUnreadBadge(1)).resolves.toBeUndefined();

    // External content and app audio: typed "unavailable".
    expect(await b.externalContent.preview("p", "https://x")).toEqual({
      ok: false,
      failure: "unavailable",
    });
    expect(await b.externalContent.image("p", { url: "https://x" })).toEqual({
      ok: false,
      failure: "unavailable",
    });
    expect(await b.appAudio.available()).toBe(false);
    expect(await b.appAudio.start("w", "window")).toEqual({ ok: false, code: "unavailable" });
    await expect(b.appAudio.stop()).resolves.toBeUndefined();
  });

  it("native voice refuses every operation and returns inert unsubscribes", async () => {
    const v = browser.nativeVoice;
    const audio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      enhancedNoiseSuppression: false,
    };
    const cap = { fps: 30, maxWidth: 1280, maxHeight: 720 };
    const publish = {
      width: 1280,
      height: 720,
      maxBitrate: 1,
      maxFramerate: 30,
      simulcast: false,
      codec: "vp8" as const,
    };
    const cameraOptions = { ...publish };
    const refusals: readonly (() => Promise<unknown>)[] = [
      () => v.setRoomKey("k"),
      () => v.clearRoomKey(),
      () => v.connect("wss://x", "t", audio),
      () => v.disconnect(1),
      () => v.setMicrophone(1, true),
      () => v.setPttGated(1, true),
      () => v.setVoiceGate(1, 0.1),
      () => v.setInputGain(1, 100),
      () => v.setAudioProcessing(1, audio),
      () => v.getStats(1),
      () => v.setSubscribed(1, "i", "s", true),
      () => v.setVideoView(1, "i", "s", true, "low"),
      () => v.setVolume(1, "i", 1),
      () => v.setScreenshareVolume(1, "i", 1),
      () => v.publishCamera(1, 1, cameraOptions),
      () => v.unpublishCamera(1, "s"),
      () => v.listCameras(),
      () => v.cameraSupport(),
      () => v.videoCodecs(),
      () => v.startCamera(1, "c", cap),
      () => v.stopCamera(1, 1),
      () => v.startCameraPreview("c", cap),
      () => v.stopCameraPreview(),
      () => v.screenSources(),
      () => v.startScreen(1, "s", cap),
      () => v.publishScreen(1, 1, publish),
      () => v.unpublishScreen(1, 1),
      () => v.publishScreenAudio(1, 1),
      () => v.unpublishScreenAudio(1, "s"),
      () => v.stopScreen(1, 1),
      () => v.changeScreen(1, "s", cap),
      () => v.setScreenQuality(1, 1, cap, publish),
      () => v.changeCamera(1, "c", cap),
      () => v.debugInfo(),
      () => v.listDevices(),
      () => v.setDevice(1, "audioinput", "d"),
      () =>
        v.startMicTest({
          input: "i",
          output: "o",
          audio,
          inputGain: 100,
          outputGain: 1,
          threshold: 0.1,
        }),
      () => v.updateMicTest(1, { kind: "outputGain", gain: 1 }),
      () => v.stopMicTest(1),
      () => v.playSound([], "d", 1),
      () => v.stopSound(1),
    ];
    for (const call of refusals) await expect(call()).rejects.toThrow();
    for (const subscribe of [v.onMicTestEvent, v.watchDevices, v.onEvent]) {
      expect(() => subscribe(() => undefined)()).not.toThrow();
    }
  });
});

// 6.13c/d: transport, storage, identity and notifications are real browser adapters, used only
// in a secure context.
describe("browser platform registry: secure-context guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** A fresh registry and fresh adapter modules, from the same module graph. */
  async function load(secure: boolean) {
    vi.resetModules();
    vi.stubGlobal("isSecureContext", secure);
    const { browser: platform } = await import("../../../src/platform/browser");
    const adapters = {
      credentials: (await import("../../../src/platform/browser/credentials")).credentials,
      http: (await import("../../../src/platform/browser/http")).http,
      identity: (await import("../../../src/platform/browser/identity")).identity,
      notifier: (await import("../../../src/platform/browser/notifications")).notifier,
      nativeProxies: (await import("../../../src/platform/browser/nativeProxies")).nativeProxies,
      pendingMessages: (await import("../../../src/platform/browser/pendingMessages"))
        .pendingMessages,
      settings: (await import("../../../src/platform/browser/settings")).settings,
      socket: (await import("../../../src/platform/browser/socket")).socket,
    };
    return { platform, adapters };
  }

  it("uses the browser adapters in a secure context", async () => {
    const { platform, adapters } = await load(true);
    for (const [member, adapter] of Object.entries(adapters)) {
      expect(platform[member as keyof typeof adapters], member).toBe(adapter);
    }
    expect(platform.serverScope).toEqual({ fixedHost: location.host });
  });

  it("keeps them inert on a page that is not a secure context", async () => {
    const { platform, adapters } = await load(false);
    for (const [member, adapter] of Object.entries(adapters)) {
      expect(platform[member as keyof typeof adapters], member).not.toBe(adapter);
    }
    await expect(platform.http.fetch("/api/v1/health")).rejects.toThrow();
    await expect(
      platform.socket.create().connect({ url: "wss://x", token: "t" }),
    ).rejects.toThrow();
    expect(await platform.credentials.save("h", "u", "t")).toBe(false);
    // The notifier is inert too: the Notification API needs a secure context.
    expect(await platform.notifier.permissionGranted()).toBe(false);
  });
});
