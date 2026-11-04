// Files dragged in or copied from the Linux file manager, read by the host
// (src-tauri/src/file_transfer.rs). WebKitGTK hands the page only their
// uri-list; WebView2 hands over real files, so Windows leaves this off.
//
// The parsing and reads live in `nativeFilesHost.ts`, loaded on the first
// drag or paste, so the startup chunk carries only this facade.
import { listen } from "@tauri-apps/api/event";
import { createLogger } from "@lib/logger";
import { webviewZoom } from "./webviewZoom";
import type { NativeFiles } from "../contracts/nativeFiles";

const log = createLogger("native-files");

const DRAG_EVENT = "native-file-drag";

function isLinuxHost(): boolean {
  if (typeof navigator === "undefined" || !("__TAURI_INTERNALS__" in globalThis)) return false;
  const ua = navigator.userAgent;
  return /\bLinux\b/.test(ua) && !/Android/.test(ua);
}

export const nativeFiles: NativeFiles = {
  get available() {
    return isLinuxHost();
  },
  onDrag(handler) {
    if (!isLinuxHost()) return () => undefined;
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<unknown>(DRAG_EVENT, (e) => {
      if (!active) return;
      void import("./nativeFilesHost").then(({ parseDrag }) => {
        const drag = parseDrag(e.payload, webviewZoom());
        if (active && drag !== null) handler(drag);
      });
    })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch((err: unknown) => log.warn("file drag listen failed", err));
    return () => {
      active = false;
      unlisten?.();
    };
  },
  async clipboardFiles() {
    if (!isLinuxHost()) return [];
    return (await import("./nativeFilesHost")).readClipboardFiles();
  },
};
