import { describe, it, expect, afterEach } from "vitest";
import { canPublishScreen } from "../../src/features/voice/native/platform";

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 16; CPH2747) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Mobile Safari/537.36";

function setHost(userAgent: string, displayMedia: boolean): void {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: userAgent });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: displayMedia ? { getDisplayMedia: () => Promise.resolve() } : {},
  });
  (globalThis as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
}

describe("canPublishScreen in the app", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["__TAURI_INTERNALS__"];
  });

  it("is false on Android, whose WebView cannot capture the screen", () => {
    setHost(ANDROID_UA, false);
    expect(canPublishScreen()).toBe(false);
  });

  it("follows the engine on Android if it ever gains capture", () => {
    setHost(ANDROID_UA, true);
    expect(canPublishScreen()).toBe(true);
  });

  it("stays true on Linux desktop, which captures through the native backend", () => {
    setHost("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15", false);
    expect(canPublishScreen()).toBe(true);
  });

  it("stays true on Windows", () => {
    setHost("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/155.0", true);
    expect(canPublishScreen()).toBe(true);
  });
});
