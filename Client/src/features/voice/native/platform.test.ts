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

const g = globalThis as unknown as { RTCPeerConnection?: unknown };
const originalPc = g.RTCPeerConnection;
function FakePeerConnection(): void {}

function withEnvironment(userAgent: string, webrtc: boolean): boolean {
  vi.stubGlobal("navigator", { userAgent });
  if (webrtc) g.RTCPeerConnection = FakePeerConnection;
  else delete g.RTCPeerConnection;
  return isLinuxDesktop();
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalPc === undefined) delete g.RTCPeerConnection;
  else g.RTCPeerConnection = originalPc;
});

describe("isLinuxDesktop", () => {
  it("is true only for a Linux webview with no WebRTC (the Tauri app on WebKitGTK)", () => {
    expect(withEnvironment(WEBKITGTK, false)).toBe(true);
  });
  it("keeps a Linux Chromium (the browser suites) on the web path", () => {
    expect(withEnvironment(CHROMIUM_LINUX, true)).toBe(false);
  });
  it("is false on Windows, with or without WebRTC", () => {
    expect(withEnvironment(WEBVIEW2, true)).toBe(false);
    expect(withEnvironment(WEBVIEW2, false)).toBe(false);
  });
  it("is false on Android", () => {
    expect(withEnvironment(ANDROID, false)).toBe(false);
  });
});
