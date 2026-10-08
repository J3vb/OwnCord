// Regression guard for WebView2's default `--disable-features` flag.
//
// Tauri/wry pass `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`
// to the WebView2 browser process by default, but setting `additionalBrowserArgs`
// REPLACES that default string rather than appending to it (see
// WindowConfig::additional_browser_args / WebViewBuilder::with_additional_browser_args).
// Our config sets additionalBrowserArgs for autoplay, which
// silently re-enables SmartScreen (URL-reputation lookups against Microsoft for
// in-webview navigations/downloads — a leak for a self-hosted, TOFU-pinned
// client) and the msWebOOUI/msPdfOOUI overlays. The dropped default must be
// re-added explicitly.

import { describe, expect, it } from "vitest";

// Asserts src-tauri/tauri.conf.json, which is inside the Client component —
// not a cross-component contract test. See docs/contributing.md#testing.
import tauriConf from "../../src-tauri/tauri.conf.json";

describe("tauri.conf.json — Windows WebView2 additionalBrowserArgs", () => {
  it("keeps wry's default --disable-features flag alongside the custom args", () => {
    const win = tauriConf.app.windows[0] as { additionalBrowserArgs?: string };
    expect(win.additionalBrowserArgs).toBeDefined();
    const args = win.additionalBrowserArgs ?? "";
    expect(args).toContain("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
  });

  it("keeps the autoplay flag but not the fake-UI flag that hides the screen picker", () => {
    const win = tauriConf.app.windows[0] as { additionalBrowserArgs?: string };
    const args = win.additionalBrowserArgs ?? "";
    expect(args).toContain("--autoplay-policy=no-user-gesture-required");
    // --use-fake-ui-for-media-stream makes getDisplayMedia skip WebView2's
    // screen/window picker; mic/camera are allowed by src-tauri/src/windows_media.rs.
    expect(args).not.toContain("--use-fake-ui-for-media-stream");
  });
});
