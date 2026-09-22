import { describe, it, expect, afterEach, vi } from "vitest";
import { isLinuxDesktop } from "./platform";

const WEBKITGTK =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const CHROMIUM_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const WEBVIEW2 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0";

function FakePeerConnection(): void {}

function withEnvironment(userAgent: string, tauri: boolean, webrtc: boolean): boolean {
  vi.stubGlobal("navigator", { userAgent });
  if (tauri) vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("RTCPeerConnection", webrtc ? FakePeerConnection : undefined);
  return isLinuxDesktop();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isLinuxDesktop", () => {
  it("is true in the Tauri app on Linux (WebKitGTK)", () => {
    expect(withEnvironment(WEBKITGTK, true, false)).toBe(true);
  });
  it("is true in the Tauri app on Linux even when the webview has WebRTC", () => {
    expect(withEnvironment(WEBKITGTK, true, true)).toBe(true);
  });
  it("keeps a Linux Chromium without a Tauri host on the web path", () => {
    expect(withEnvironment(CHROMIUM_LINUX, false, true)).toBe(false);
    expect(withEnvironment(CHROMIUM_LINUX, false, false)).toBe(false);
  });
  it("is false on Windows", () => {
    expect(withEnvironment(WEBVIEW2, true, true)).toBe(false);
  });
  it("is false on Android", () => {
    expect(withEnvironment(ANDROID, true, true)).toBe(false);
  });
});
