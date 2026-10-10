// Regression guard: wry's native drag-drop handler swallows the HTML5
// `drop`/`dragover` events a file dragged from the OS file manager would raise
// in the webview (WebView2 and WebKitGTK alike). With it on, dropping a file or
// image on the composer reaches no JS handler at all. The composer
// (MessageInput) listens for the HTML5 events, so the native handler must stay
// off for the main window.

import { describe, expect, it } from "vitest";

// Asserts src-tauri/tauri.conf.json, which is inside the Client component —
// not a cross-component contract test. See docs/contributing.md#testing.
import tauriConf from "../../src-tauri/tauri.conf.json";

describe("tauri.conf.json — main window drag-drop", () => {
  it("turns the native drag-drop handler off so HTML5 file drops reach the page", () => {
    const win = tauriConf.app.windows[0] as { dragDropEnabled?: boolean };
    expect(win.dragDropEnabled).toBe(false);
  });
});
