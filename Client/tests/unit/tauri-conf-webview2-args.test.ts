// Regression guard for WebView2's default `--disable-features` flag.
//
// Tauri/wry pass `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`
// to the WebView2 browser process by default, but setting `additionalBrowserArgs`
// REPLACES that default string rather than appending to it (see
// WindowConfig::additional_browser_args / WebViewBuilder::with_additional_browser_args).
// Our config sets additionalBrowserArgs for autoplay/fake-media-stream, which
// silently re-enables SmartScreen (URL-reputation lookups against Microsoft for
// in-webview navigations/downloads — a leak for a self-hosted, TOFU-pinned
// client) and the msWebOOUI/msPdfOOUI overlays. The dropped default must be
// re-added explicitly.

import { describe, expect, it } from "vitest";

import tauriConf from "../../src-tauri/tauri.conf.json";

describe("tauri.conf.json — Windows WebView2 additionalBrowserArgs", () => {
  it("keeps wry's default --disable-features flag alongside the custom args", () => {
    const win = tauriConf.app.windows[0] as { additionalBrowserArgs?: string };
    expect(win.additionalBrowserArgs).toBeDefined();
    const args = win.additionalBrowserArgs ?? "";
    expect(args).toContain("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
  });

  it("still passes the autoplay and fake-media-stream flags this client needs", () => {
    const win = tauriConf.app.windows[0] as { additionalBrowserArgs?: string };
    const args = win.additionalBrowserArgs ?? "";
    expect(args).toContain("--autoplay-policy=no-user-gesture-required");
    expect(args).toContain("--use-fake-ui-for-media-stream");
  });
});
